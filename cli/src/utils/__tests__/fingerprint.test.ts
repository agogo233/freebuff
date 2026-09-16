import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FINGERPRINT_MASKED } from '@codebuff/common/constants/privacy-tuning'

import {
  calculateFingerprint,
  getFingerprintType,
  generateFingerprintIdSync,
  resetFingerprintCacheForTests,
} from '../fingerprint'

describe('fingerprint utilities', () => {
  describe('getFingerprintType', () => {
    describe('enhanced fingerprints', () => {
      test('should detect enhanced- prefix as enhanced_cli', () => {
        expect(getFingerprintType('enhanced-abc123')).toBe('enhanced_cli')
      })

      test('should detect enhanced fingerprint with full hash', () => {
        const fullHash = 'enhanced-Ks7mN2pQxR3vW5yZ8aB4cD6eF9gH1iJ2kL4mN5oP7qR8sT0uV1wX3yZ'
        expect(getFingerprintType(fullHash)).toBe('enhanced_cli')
      })

      test('should detect enhanced- prefix with empty suffix', () => {
        expect(getFingerprintType('enhanced-')).toBe('enhanced_cli')
      })
    })

    describe('legacy fingerprints', () => {
      test('should detect codebuff-cli- prefix as legacy', () => {
        expect(getFingerprintType('codebuff-cli-abc12345')).toBe('legacy')
      })

      test('should detect legacy- prefix as legacy', () => {
        expect(getFingerprintType('legacy-abc123-xyz789')).toBe('legacy')
      })

      test('should detect codebuff-cli- prefix with any suffix', () => {
        expect(getFingerprintType('codebuff-cli-')).toBe('legacy')
        expect(getFingerprintType('codebuff-cli-randomsuffix')).toBe('legacy')
        expect(getFingerprintType('codebuff-cli-12345678')).toBe('legacy')
      })

      test('should detect legacy- prefix with any suffix', () => {
        expect(getFingerprintType('legacy-')).toBe('legacy')
        expect(getFingerprintType('legacy-hash-suffix')).toBe('legacy')
      })
    })

    describe('unknown fingerprints', () => {
      test('should return unknown for empty string', () => {
        expect(getFingerprintType('')).toBe('unknown')
      })

      test('should return unknown for unrecognized prefix', () => {
        expect(getFingerprintType('unknown-prefix-123')).toBe('unknown')
      })

      test('should return unknown for partial matches', () => {
        // Should not match if prefix is incomplete
        expect(getFingerprintType('enhance-abc123')).toBe('unknown')
        expect(getFingerprintType('codebuff-abc123')).toBe('unknown')
        expect(getFingerprintType('lega-abc123')).toBe('unknown')
      })

      test('should return unknown for SDK fingerprints', () => {
        expect(getFingerprintType('codebuff-sdk-abc123')).toBe('unknown')
      })

      test('should return unknown for random strings', () => {
        expect(getFingerprintType('random-string')).toBe('unknown')
        expect(getFingerprintType('abc123')).toBe('unknown')
        expect(getFingerprintType('fingerprint')).toBe('unknown')
      })

      test('should be case-sensitive', () => {
        expect(getFingerprintType('Enhanced-abc123')).toBe('unknown')
        expect(getFingerprintType('ENHANCED-abc123')).toBe('unknown')
        expect(getFingerprintType('Codebuff-cli-abc123')).toBe('unknown')
        expect(getFingerprintType('LEGACY-abc123')).toBe('unknown')
      })
    })
  })

  // Masked and legacy builds share nothing: the masked id is a persisted
  // local value, while the legacy id is fresh randomness per call. Branch the
  // suite on the switch so both builds keep coverage of their own contract.
  describe('generateFingerprintIdSync', () => {
    if (FINGERPRINT_MASKED) {
      // One shared dir for the whole branch, and the module cache reset first:
      // another test file in the same process may have warmed the in-memory id
      // under a different config dir, which would leave the persistence check
      // below reading a directory the id was never written to.
      let savedConfigDir: string | undefined
      let tempDir = ''

      beforeAll(() => {
        resetFingerprintCacheForTests()
        savedConfigDir = process.env.FREEBUFF_CONFIG_DIR
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-'))
        process.env.FREEBUFF_CONFIG_DIR = tempDir
      })

      afterAll(() => {
        if (savedConfigDir === undefined) {
          delete process.env.FREEBUFF_CONFIG_DIR
        } else {
          process.env.FREEBUFF_CONFIG_DIR = savedConfigDir
        }
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
        resetFingerprintCacheForTests()
      })

      test('returns the same masked id on every call', () => {
        expect(generateFingerprintIdSync()).toBe(generateFingerprintIdSync())
      })

      test('keeps the enhanced shape so type detection is unchanged', () => {
        const fingerprint = generateFingerprintIdSync()
        expect(fingerprint.startsWith('enhanced-')).toBe(true)
        expect(getFingerprintType(fingerprint)).toBe('enhanced_cli')
      })

      test('persists the id to the config dir', () => {
        const fingerprint = generateFingerprintIdSync()
        const stored = fs
          .readFileSync(path.join(tempDir, 'cli-fingerprint.txt'), 'utf8')
          .trim()
        expect(stored).toBe(fingerprint)
      })

      test('sync and async entries agree with each other', async () => {
        expect(await calculateFingerprint()).toBe(generateFingerprintIdSync())
      })
    } else {
      describe('format validation', () => {
        test('should return string starting with codebuff-cli-', () => {
          const fingerprint = generateFingerprintIdSync()
          expect(fingerprint.startsWith('codebuff-cli-')).toBe(true)
        })

        test('should return fingerprint of expected length', () => {
          const fingerprint = generateFingerprintIdSync()
          // Format: codebuff-cli- (13 chars) + 8 random chars = 21 chars
          expect(fingerprint.length).toBe(21)
        })

        test('should contain only valid base64url characters in suffix', () => {
          const fingerprint = generateFingerprintIdSync()
          const suffix = fingerprint.replace('codebuff-cli-', '')
          // base64url alphabet: A-Z, a-z, 0-9, -, _
          const base64urlPattern = /^[A-Za-z0-9_-]+$/
          expect(base64urlPattern.test(suffix)).toBe(true)
        })

        test('should have exactly 8 characters in the random suffix', () => {
          const fingerprint = generateFingerprintIdSync()
          const suffix = fingerprint.replace('codebuff-cli-', '')
          expect(suffix.length).toBe(8)
        })
      })

      describe('uniqueness', () => {
        test('should generate unique fingerprints across multiple calls', () => {
          const fingerprints = new Set<string>()
          const iterations = 100

          for (let i = 0; i < iterations; i++) {
            fingerprints.add(generateFingerprintIdSync())
          }

          // All fingerprints should be unique
          expect(fingerprints.size).toBe(iterations)
        })

        test('should generate different fingerprints on consecutive calls', () => {
          const first = generateFingerprintIdSync()
          const second = generateFingerprintIdSync()
          const third = generateFingerprintIdSync()

          expect(first).not.toBe(second)
          expect(second).not.toBe(third)
          expect(first).not.toBe(third)
        })
      })

      describe('type detection integration', () => {
        test('should be detected as legacy by getFingerprintType', () => {
          const fingerprint = generateFingerprintIdSync()
          expect(getFingerprintType(fingerprint)).toBe('legacy')
        })

        test('multiple generated fingerprints should all be detected as legacy', () => {
          for (let i = 0; i < 10; i++) {
            const fingerprint = generateFingerprintIdSync()
            expect(getFingerprintType(fingerprint)).toBe('legacy')
          }
        })
      })
    }
  })
})
