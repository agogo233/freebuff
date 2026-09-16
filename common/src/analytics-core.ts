import { PostHog } from 'posthog-node'

import { TELEMETRY_DISABLED } from './constants/privacy-tuning'
import { createExceptionBeforeSend } from './util/exception-budget'

/**
 * Shared analytics core module.
 * Provides common interfaces, types, and utilities used by both
 * server-side (common/src/analytics.ts) and CLI (cli/src/utils/analytics.ts) analytics.
 */

/** Interface for PostHog client methods used for event capture */
export interface AnalyticsClient {
  capture: (params: {
    distinctId: string
    event: string
    properties?: Record<string, any>
  }) => void
  flush: () => Promise<void>
}

/** Extended client interface with identify, alias, and exception capture (used by CLI) */
export interface AnalyticsClientWithIdentify extends AnalyticsClient {
  identify: (params: {
    distinctId: string
    properties?: Record<string, any>
  }) => void
  /** Links an alias (previous anonymous ID) to a distinctId (real user ID) */
  alias: (data: { distinctId: string; alias: string }) => void
  captureException: (
    error: any,
    distinctId: string,
    properties?: Record<string, any>,
  ) => void
}

/** Environment name type */
export type AnalyticsEnvName = 'dev' | 'test' | 'prod'

/** Base analytics configuration */
export interface AnalyticsConfig {
  envName: AnalyticsEnvName
  posthogApiKey: string
  posthogHostUrl: string
}

/** Options for creating a PostHog client */
export interface PostHogClientOptions {
  host: string
  flushAt?: number
  flushInterval?: number
  enableExceptionAutocapture?: boolean
}

/**
 * Returned when telemetry is switched off. A stub rather than a real client is
 * load-bearing: `new PostHog` installs uncaught-exception handlers as a side
 * effect of construction, so the only way to disable exception autocapture is to
 * never construct the client at all. `flush` stays async to match the contract.
 */
const NOOP_ANALYTICS_CLIENT: AnalyticsClientWithIdentify = {
  capture: () => undefined,
  flush: async () => undefined,
  identify: () => undefined,
  alias: () => undefined,
  captureException: () => undefined,
}

/**
 * Default PostHog client factory.
 * Creates a real PostHog client instance.
 *
 * Every client gets the exception budget, per process: it is the one place all
 * three posthog-node surfaces (CLI, Desktop, server) pass through, and both
 * ways an exception reaches PostHog — `captureException` from the CLI's error
 * logger and `enableExceptionAutocapture`'s uncaught/unhandled handlers — run
 * `before_send`. See util/exception-budget.ts for what a loop costs without it.
 *
 * `TELEMETRY_DISABLED` short-circuits before construction, which is what makes
 * this the one choke point for every analytics surface in the CLI: the common
 * `trackEvent`, the CLI `trackEvent`/`identify`/`captureException`, and the
 * SDK runtime wrapper all resolve to a client made here.
 */
export function createPostHogClient(
  apiKey: string,
  options: PostHogClientOptions,
): AnalyticsClientWithIdentify {
  if (TELEMETRY_DISABLED) return NOOP_ANALYTICS_CLIENT
  return new PostHog(apiKey, {
    ...options,
    before_send: createExceptionBeforeSend(),
  }) as AnalyticsClientWithIdentify
}

/**
 * Generates a unique anonymous ID for pre-login tracking.
 * Uses crypto.randomUUID() for uniqueness.
 */
export function generateAnonymousId(): string {
  return `anon_${crypto.randomUUID()}`
}
