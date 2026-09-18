/**
 * Regression guards for `ProviderMetadata`, the type that carries
 * provider-specific payloads between the SDK and the ai package.
 *
 * The bug this exists for: ai v7.0.105 (via @ai-sdk/provider@4.0.17) reworked
 * its JSONValue to `Readonly<JSONObject> | readonly JSONValue[]`, which is not
 * assignable to this repo's mutable JSONValue. Six call sites broke at once
 * (messages.ts, stream-parser.ts, llm.ts) and upstream's own CI went red on
 * every commit. `ProviderMetadata` now treats each payload as opaque so the
 * SDK accepts whatever the ai package hands back.
 *
 * What these tests actually pin: the schema's runtime contract (round-trip,
 * rejection) and the type-level fact that readonly payloads stay assignable.
 * Note the `satisfies` below is NOT a build-time tripwire for tightening the
 * type back to strict JSONValue — TS ignores readonly modifiers on object
 * properties during assignability, so a readonly literal still passes a
 * stricter target. A real tightening would surface as TS2322 at the ai-facing
 * call sites (caught by `bun run build:sdk`'s declaration bundling), not here.
 */

import { describe, expect, test } from 'bun:test'

import { providerMetadataSchema, type ProviderMetadata } from '../provider-metadata'

// Type-level: a readonly literal (the shape ai hands back) must stay
// assignable. `satisfies` compiles only while the looseness holds.
const readonlyPayload = {
  codebuff: {
    codebuff_metadata: { run_id: 'r1', client_id: 'c1' },
    usage: { cost: 1.23 },
  },
  openaiCompatible: { reasoning: { exclude: true } },
} as const satisfies ProviderMetadata

describe('ProviderMetadata', () => {
  test('accepts readonly provider payloads (ai v7 shape)', () => {
    expect(readonlyPayload.codebuff).toEqual({
      codebuff_metadata: { run_id: 'r1', client_id: 'c1' },
      usage: { cost: 1.23 },
    })
    expect(readonlyPayload.openaiCompatible?.reasoning.exclude).toBe(true)
  })

  test('providerMetadataSchema round-trips a JSON payload', () => {
    const payload = {
      codebuff: {
        run_id: 'r1',
        client_id: 'c1',
        n: 1,
        provider: { order: ['Anthropic'], allow_fallbacks: true },
      },
    }
    const parsed = providerMetadataSchema.parse(payload)
    expect(parsed).toEqual(payload)
  })

  test('providerMetadataSchema rejects non-JSON payloads', () => {
    expect(() =>
      providerMetadataSchema.parse({ codebuff: { run_id: 42n } }),
    ).toThrow()
  })
})
