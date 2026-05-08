import { type SQL, sql } from "drizzle-orm"
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core"

/**
 * Render a single column-fragment for `CREATE TABLE`. Column-level
 * `UNIQUE` / `PRIMARY KEY` / `NOT NULL` / `DEFAULT (...)` are read off
 * the drizzle column metadata (`name`, `getSQLType()`, `notNull`,
 * `primary`, `isUnique`, `default`, `hasDefault`).
 */
type RenderableColumn = {
  readonly name: string
  readonly notNull: boolean
  readonly primary: boolean
  readonly isUnique: boolean
  readonly hasDefault: boolean
  readonly default: unknown
  getSQLType(): string
}

const renderDefault = (value: unknown): string => {
  if (value === undefined) return ""
  // drizzle's `sql` returns an SQL object whose stringified form preserves
  // the parenthesised expression. Identifiable via the `queryChunks` shape;
  // safer to brand-check via `instanceof` is unavailable across realms, so
  // we check for a `getSQL` method as a duck-type.
  if (typeof value === "object" && value !== null && "queryChunks" in value) {
    const inner = (value as SQL).getSQL().toQuery({
      escapeName: (n) => `"${n}"`,
      escapeParam: (_, v) => String(v),
      escapeString: (s) => `'${s.replace(/'/g, "''")}'`,
    })
    return ` DEFAULT (${inner.sql})`
  }
  if (typeof value === "string") return ` DEFAULT '${value.replace(/'/g, "''")}'`
  if (typeof value === "number" || typeof value === "boolean") return ` DEFAULT ${String(value)}`
  return ""
}

const renderColumn = (col: RenderableColumn): string => {
  const parts: string[] = [col.name, col.getSQLType()]
  if (col.notNull) parts.push("NOT NULL")
  if (col.primary) parts.push("PRIMARY KEY")
  if (col.isUnique) parts.push("UNIQUE")
  const def = col.hasDefault ? renderDefault(col.default) : ""
  return `${parts.join(" ")}${def}`.trim()
}

/**
 * Render `CREATE TABLE IF NOT EXISTS` plus the table's `CREATE INDEX
 * IF NOT EXISTS` statements from a drizzle `SQLiteTable`. The output
 * is a list of statements (callers `.exec` each one in turn).
 *
 * Drizzle table is the single source of truth for column shape;
 * adding a new column / index in `apps/default/src/server/schema/*.ts`
 * automatically appears in the DO's `ensureDurableObjectSchema`
 * idempotent migration with no hand-rolled DDL drift.
 */
const tableToDDL = (table: SQLiteTable): readonly string[] => {
  const cfg = getTableConfig(table)
  const cols = cfg.columns.map((c) => renderColumn(c as unknown as RenderableColumn))
  const create = `CREATE TABLE IF NOT EXISTS ${cfg.name} (\n  ${cols.join(",\n  ")}\n)`
  const indexes = cfg.indexes.map((idx) => {
    const idxCfg = (
      idx as unknown as { config: { name: string; columns: { name: string }[]; unique?: boolean } }
    ).config
    const colNames = idxCfg.columns.map((c) => c.name).join(", ")
    const uniq = idxCfg.unique === true ? "UNIQUE " : ""
    return `CREATE ${uniq}INDEX IF NOT EXISTS ${idxCfg.name}\n  ON ${cfg.name} (${colNames})`
  })
  return [create, ...indexes]
}

/** Render DDL for a list of tables, in declaration order. */
export const tablesToDDL = (tables: readonly SQLiteTable[]): readonly string[] =>
  tables.flatMap(tableToDDL)

// Suppress the unused import lint until `sql` is referenced inline.
void sql
