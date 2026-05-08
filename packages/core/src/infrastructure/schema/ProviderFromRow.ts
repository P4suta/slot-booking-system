import type { Schema } from "effect"
import { type Provider, ProviderSchema } from "../../domain/entities/Provider.js"
import type { Skill } from "../../domain/value-objects/Skill.js"
import { entityFromRow } from "./entityFromRow.js"
import { providers } from "./tables/providers.js"

type ProviderEncoded = Schema.Codec.Encoded<typeof ProviderSchema>
type ProviderRow = typeof providers.$inferSelect

/**
 * `Provider` ↔ `providers` row codec. Overlay handles `Set<Skill>` ↔
 * `string[]` (sorted on encode for deterministic row hash).
 */
export const ProviderFromRow = entityFromRow<Provider, ProviderEncoded, ProviderRow>({
  table: providers,
  domain: ProviderSchema,
  overlay: {
    decode: (row) => ({
      ...row,
      skills: new Set(row.skills as readonly Skill[]),
    }),
    encode: (entity) => ({
      ...entity,
      skills: [...entity.skills].sort(),
    }),
  },
})
