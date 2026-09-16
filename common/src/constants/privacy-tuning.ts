/**
 * Fork switches for the no-telemetry, ad-invisible build of this CLI.
 *
 * ## Why checked-in defaults rather than env-only
 *
 * Nothing in this family is read from the environment by the bundled CLI.
 * `IS_FREEBUFF` in `cli/src/utils/constants.ts` is injected with `--define` at
 * build time for exactly that reason. A checked-in constant is therefore the
 * only default a distributed build can actually observe.
 *
 * Each switch still honours an environment override, and that override is the
 * intended rollback path: `TELEMETRY_DISABLED=false` restores analytics for a
 * single run with no rebuild and no code change.
 *
 * ## What these switches deliberately leave alone
 *
 * Ad SETTLEMENT is untouched. `/api/v1/ads/impression`, `/api/v1/ads/click` and
 * the zeroclick impression POST keep going. `ADS_HIDDEN_FROM_USER` hides the
 * pixels, not the ledger: the server still counts every ad as shown.
 *
 * The sponsored-proposal channel is also untouched on purpose. That card is a
 * user-initiated earning flow, not a display ad, so suppressing it would
 * quietly delete a feature instead of hiding an interruption.
 */

const ON = new Set(['1', 'true', 'yes', 'on'])
const OFF = new Set(['0', 'false', 'no', 'off'])

/** Every switch below defaults on in this fork. */
const FORK_DEFAULT = true

function flag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return FORK_DEFAULT
  if (ON.has(raw)) return true
  if (OFF.has(raw)) return false
  // A misspelled override must not silently keep the default. Warn once rather
  // than throw: env typos should never break a launch.
  console.warn(
    `[privacy-tuning] Ignoring unrecognized ${name}=${JSON.stringify(raw)}; using default ${FORK_DEFAULT}.`,
  )
  return FORK_DEFAULT
}

/**
 * No product analytics. The PostHog client is never constructed, which is the
 * load-bearing part: `new PostHog` installs uncaught-exception handlers as a
 * side effect of construction, so skipping construction is the only way to kill
 * exception autocapture rather than merely silencing it. `flushAnalytics()`
 * becomes a no-op, and the env schema still requires a PostHog key, so this
 * switch needs no schema change — the fork ships a placeholder value.
 */
export const TELEMETRY_DISABLED = flag('TELEMETRY_DISABLED')

/**
 * No client-log forwarding. Analytics mirroring and the Axiom-only event path
 * both drain through the same shipper, so both go quiet here.
 */
export const LOG_SHIPPING_DISABLED = flag('LOG_SHIPPING_DISABLED')

/**
 * Display ads are never rendered. Requesting, caching, rotation and the
 * frequency caps inside the ads hook all keep running — only the pixels go, and
 * each suppressed card still fires its impression.
 */
export const ADS_HIDDEN_FROM_USER = flag('ADS_HIDDEN_FROM_USER')

/**
 * The device fingerprint is a locally generated, locally persisted identifier.
 * The enhanced path (machine serial, MAC addresses, hostname) is never read.
 * The value is stable across restarts and differs per machine, which is why it
 * cannot be a single shared constant.
 */
export const FINGERPRINT_MASKED = flag('FINGERPRINT_MASKED')
