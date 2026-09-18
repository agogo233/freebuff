import z from 'zod/v4'

import { jsonValueSchema } from '../json'

// ai v7.0.105 types provider payloads as Readonly<JSONObject> / readonly
// JSONValue[], which is not assignable to the mutable JSONValue above. Keep
// the two-level shape but treat each provider payload as opaque so the SDK
// accepts whatever the ai package hands back.
export type ProviderMetadata = Record<
  string,
  Record<string, any>
>

export const providerMetadataSchema: z.ZodType<ProviderMetadata> = z.record(
  z.string(),
  z.record(z.string(), jsonValueSchema.optional()),
)
