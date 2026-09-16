/**
 * Enhanced fingerprinting for CLI authentication.
 *
 * Uses hardware-based identifiers to create deterministic fingerprints,
 * making it harder for users to game the system by creating multiple accounts.
 *
 * Falls back to legacy random fingerprints if enhanced fingerprinting fails.
 */

import { createHash, randomBytes } from 'node:crypto'
import { cpus, networkInterfaces } from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { FINGERPRINT_MASKED } from '@codebuff/common/constants/privacy-tuning'

import { trackEvent } from './analytics'
import { getConfigDir } from './config-dir'
import { detectShell } from './detect-shell'
import { logger } from './logger'

// Lazy imports for optional dependencies
let machineIdModule: typeof import('node-machine-id') | null = null
let systeminformationModule: typeof import('systeminformation') | null = null

async function getMachineId(): Promise<string> {
  if (!machineIdModule) {
    machineIdModule = await import('node-machine-id')
  }
  const id = await machineIdModule.machineId()
  // Validate that we got a real machine ID, not an empty or placeholder value.
  // Throwing here triggers the legacy fallback in calculateFingerprint().
  if (!id || id === 'unknown' || id.length < 8) {
    throw new Error('Invalid machine ID returned')
  }
  return id
}

async function getSystemInfo(): Promise<{
  system: { manufacturer: string; model: string; serial: string; uuid: string }
  cpu: { manufacturer: string; brand: string; cores: number; physicalCores: number }
  os: { platform: string; distro: string; arch: string; hostname: string }
}> {
  try {
    if (!systeminformationModule) {
      systeminformationModule = await import('systeminformation')
    }
    const [systemInfo, cpuInfo, osInfo] = await Promise.all([
      systeminformationModule.system(),
      systeminformationModule.cpu(),
      systeminformationModule.osInfo(),
    ])
    return {
      system: {
        manufacturer: systemInfo.manufacturer,
        model: systemInfo.model,
        serial: systemInfo.serial,
        uuid: systemInfo.uuid,
      },
      cpu: {
        manufacturer: cpuInfo.manufacturer,
        brand: cpuInfo.brand,
        cores: cpuInfo.cores,
        physicalCores: cpuInfo.physicalCores,
      },
      os: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        arch: osInfo.arch,
        hostname: osInfo.hostname,
      },
    }
  } catch {
    return {
      system: { manufacturer: '', model: '', serial: '', uuid: '' },
      cpu: { manufacturer: '', brand: '', cores: 0, physicalCores: 0 },
      os: { platform: process.platform, distro: '', arch: process.arch, hostname: '' },
    }
  }
}

/**
 * Generates an enhanced CLI fingerprint using hardware identifiers.
 * This is deterministic - the same machine will always produce the same fingerprint.
 * Throws if machine ID cannot be obtained (to trigger legacy fallback).
 */
async function calculateEnhancedFingerprint(): Promise<string> {
  // getMachineId will throw if it can't get a valid machine ID
  const machineIdValue = await getMachineId()
  
  const [sysInfo, shell, networkInfo] = await Promise.all([
    getSystemInfo(),
    Promise.resolve(detectShell()),
    Promise.resolve(networkInterfaces()),
  ])

  // Extract MAC addresses for additional uniqueness
  const macAddresses = Object.values(networkInfo)
    .flat()
    .filter(
      (iface) =>
        iface && !iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00',
    )
    .map((iface) => iface!.mac)
    .sort()

  const fingerprintInfo = {
    system: sysInfo.system,
    cpu: sysInfo.cpu,
    os: sysInfo.os,
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      shell,
      cpuCount: cpus().length,
    },
    network: {
      macAddresses,
      interfaceCount: Object.keys(networkInfo).length,
    },
    machineId: machineIdValue,
    fingerprintVersion: '2.0',
  }

  const fingerprintString = JSON.stringify(fingerprintInfo)
  const fingerprintHash = createHash('sha256')
    .update(fingerprintString)
    .digest('base64url')

  return `enhanced-${fingerprintHash}`
}

/**
 * Generates a legacy fingerprint with a random suffix.
 * Used as a fallback when enhanced fingerprinting fails.
 */
function calculateLegacyFingerprint(): string {
  const randomSuffix = randomBytes(6).toString('base64url').substring(0, 8)
  return `codebuff-cli-${randomSuffix}`
}

// --- Masked fingerprint -----------------------------------------------------
//
// When masking is on, the enhanced path above is never entered: no machine
// serial, no MAC addresses, no hostname. The id is a locally generated value
// persisted in the config dir, so it survives restarts and differs per machine
// without anything about this box ever leaving it.

const MASKED_FILE_NAME = 'cli-fingerprint.txt'

let maskedFingerprintId: string | null = null

function maskedFingerprintPath(): string {
  return path.join(getConfigDir(), MASKED_FILE_NAME)
}

function readMaskedFingerprint(): string | null {
  try {
    const raw = fs.readFileSync(maskedFingerprintPath(), 'utf8').trim()
    // Strict shape check, not just the prefix: a truncated or dirty file must
    // not become a permanent id that still reports as enhanced.
    if (!/^enhanced-[A-Za-z0-9_-]{16,}$/.test(raw)) return null
    return raw
  } catch {
    return null
  }
}

/** Test-only reset for the in-memory caches above. */
export function resetFingerprintCacheForTests(): void {
  maskedFingerprintId = null
  cachedFingerprintPromise = null
}

/**
 * Load-or-create the masked id. Synchronous so the sync entry point below can
 * share it with the async one — two entries returning two different ids in the
 * same session is exactly the failure masking must avoid.
 */
function loadOrCreateMaskedFingerprint(): string {
  if (maskedFingerprintId) return maskedFingerprintId
  const existing = readMaskedFingerprint()
  if (existing) {
    maskedFingerprintId = existing
    return existing
  }
  const id = `enhanced-${createHash('sha256').update(randomBytes(16)).digest('base64url')}`
  maskedFingerprintId = id
  try {
    // The config dir may not exist on a fresh machine; without the mkdir the
    // write fails silently and the id changes on every restart.
    fs.mkdirSync(getConfigDir(), { recursive: true })
    fs.writeFileSync(maskedFingerprintPath(), `${id}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch {
    // Best effort: even if the file cannot be written, this session keeps the
    // same id in memory and nothing hardware-derived ever leaves the box.
  }
  return id
}

/**
 * Cached fingerprint promise. Populated on first call and reused for the
 * process lifetime so every auth step in a session ships the same fingerprint
 * to the server.
 */
let cachedFingerprintPromise: Promise<string> | null = null

/**
 * Returns the process-wide CLI fingerprint, computing it on first call.
 * Safe to call from multiple places — the first caller wins and the rest
 * await the same promise.
 */
export function getFingerprintId(): Promise<string> {
  if (!cachedFingerprintPromise) {
    cachedFingerprintPromise = calculateFingerprint()
  }
  return cachedFingerprintPromise
}

/**
 * Main fingerprint function.
 * Tries enhanced fingerprinting first, falls back to legacy if it fails.
 */
export async function calculateFingerprint(): Promise<string> {
  if (FINGERPRINT_MASKED) {
    const fingerprint = loadOrCreateMaskedFingerprint()
    trackEvent(AnalyticsEvent.FINGERPRINT_GENERATED, {
      fingerprintType: 'enhanced_cli',
      success: true,
    })
    return fingerprint
  }
  try {
    const fingerprint = await calculateEnhancedFingerprint()
    logger.debug(
      {
        fingerprintType: 'enhanced_cli',
        fingerprintId: fingerprint.substring(0, 20) + '...',
      },
      'Enhanced CLI fingerprint generated successfully',
    )
    trackEvent(AnalyticsEvent.FINGERPRINT_GENERATED, {
      fingerprintType: 'enhanced_cli',
      success: true,
    })
    return fingerprint
  } catch (enhancedError) {
    logger.info(
      {
        errorMessage:
          enhancedError instanceof Error ? enhancedError.message : String(enhancedError),
        fingerprintType: 'enhanced_failed_fallback',
      },
      'Enhanced CLI fingerprinting failed, using legacy fallback',
    )

    try {
      const fingerprint = calculateLegacyFingerprint()
      logger.debug(
        {
          fingerprintType: 'legacy_fallback',
          fingerprintId: fingerprint,
        },
        'Legacy fingerprint generated successfully as fallback',
      )
      trackEvent(AnalyticsEvent.FINGERPRINT_GENERATED, {
        fingerprintType: 'legacy',
        success: true,
        fallbackReason:
          enhancedError instanceof Error ? enhancedError.message : 'unknown',
      })
      return fingerprint
    } catch (legacyError) {
      logger.error(
        {
          errorMessage:
            legacyError instanceof Error ? legacyError.message : String(legacyError),
          fingerprintType: 'failed',
        },
        'Both enhanced and legacy fingerprint generation failed',
      )
      throw new Error('Fingerprint generation failed')
    }
  }
}

/**
 * Synchronous fingerprint generation (legacy only, unless masking is on — then
 * it returns the same persisted masked id as the async entry, and neither is
 * hardware-derived).
 * Use this only when async is not possible (e.g., initial state).
 * @deprecated Prefer calculateFingerprint() for hardware-based fingerprinting
 */
export function generateFingerprintIdSync(): string {
  if (FINGERPRINT_MASKED) return loadOrCreateMaskedFingerprint()
  return calculateLegacyFingerprint()
}

/**
 * Detects the fingerprint type from a fingerprint ID.
 */
export function getFingerprintType(
  fingerprintId: string,
): 'enhanced_cli' | 'legacy' | 'unknown' {
  if (fingerprintId.startsWith('enhanced-')) {
    return 'enhanced_cli'
  }
  if (fingerprintId.startsWith('codebuff-cli-') || fingerprintId.startsWith('legacy-')) {
    return 'legacy'
  }
  return 'unknown'
}
