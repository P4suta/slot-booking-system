/**
 * Kanban column descriptor table (S19 / ADR-0087).
 *
 * The staff page renders 5 visually-similar columns (Waiting,
 * Calling, Serving, PendingNoShow, History). Each is a value:
 * a `ColumnDescriptor` carries the label, the source array key
 * on `StaffShopState`, the colour tone, and the empty-state
 * copy. `Kanban.svelte` renders one `<KanbanColumn>` per
 * descriptor — adding / removing / reordering columns is a
 * one-line edit here.
 */
import type { StaffProjectionEntry, StaffShopState } from "@booking/core"

type ColumnId = "waiting" | "calling" | "serving" | "pendingNoShow" | "terminal"

export type ColumnTone = "neutral" | "accent" | "warning" | "muted"

export type ColumnDescriptor = {
  readonly id: ColumnId
  readonly label: string
  readonly source: keyof Pick<
    StaffShopState,
    "waitingPreview" | "calling" | "serving" | "pendingNoShow" | "terminal"
  >
  readonly tone: ColumnTone
  readonly emptyMessage: string
}

export const COLUMNS: readonly ColumnDescriptor[] = [
  {
    id: "waiting",
    label: "順番待ち",
    source: "waitingPreview",
    tone: "neutral",
    emptyMessage: "順番待ちはいません",
  },
  {
    id: "calling",
    label: "呼び出し中",
    source: "calling",
    tone: "accent",
    emptyMessage: "呼び出し中の順番待ちはいません",
  },
  {
    id: "serving",
    label: "対応中",
    source: "serving",
    tone: "accent",
    emptyMessage: "対応中の順番待ちはいません",
  },
  {
    id: "pendingNoShow",
    label: "未応答待ち",
    source: "pendingNoShow",
    tone: "warning",
    emptyMessage: "未応答待ちの順番待ちはいません",
  },
  {
    id: "terminal",
    label: "履歴",
    source: "terminal",
    tone: "muted",
    emptyMessage: "本日の履歴はまだありません",
  },
]

export const entriesFor = (
  state: StaffShopState,
  column: ColumnDescriptor,
): readonly StaffProjectionEntry[] => state[column.source]
