import type { Schema } from "effect"
import { type Service, ServiceSchema } from "../../domain/entities/Service.js"
import type { ResourceType } from "../../domain/value-objects/ResourceType.js"
import type { Skill } from "../../domain/value-objects/Skill.js"
import { entityFromRow } from "./entityFromRow.js"
import { services } from "./tables/services.js"

type ServiceEncoded = Schema.Codec.Encoded<typeof ServiceSchema>
type ServiceRow = typeof services.$inferSelect

/**
 * `Service` ↔ `services` row codec. Overlay handles `Set<Skill>` ↔
 * `string[]` and `Set<ResourceType>` ↔ `string[]` (sorted on encode
 * for deterministic row hash).
 */
export const ServiceFromRow = entityFromRow<Service, ServiceEncoded, ServiceRow>({
  table: services,
  domain: ServiceSchema,
  overlay: {
    decode: (row) => ({
      ...row,
      requiredSkills: new Set(row.requiredSkills as readonly Skill[]),
      requiredResourceTypes: new Set(row.requiredResourceTypes as readonly ResourceType[]),
    }),
    encode: (entity) => ({
      ...entity,
      requiredSkills: [...entity.requiredSkills].sort(),
      requiredResourceTypes: [...entity.requiredResourceTypes].sort(),
    }),
  },
})
