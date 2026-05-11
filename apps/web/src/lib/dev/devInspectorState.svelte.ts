/**
 * Selection cursor for the dev inspector's Detail pane
 * (Stage 23 / ADR-0092).
 *
 * Modelled as a tagged-union state ADT — the Detail pane reads
 * the cursor and a `$derived.by` resolves the underlying entry
 * from whichever feed produced it (`ringSnapshot` for ring rows,
 * `devLogStream.entries` for stream rows, the live store value
 * for state). Mirrors the discriminated-union pattern used by
 * `ModalHost` in the customer / staff Modal surfaces.
 */

export type DevInspectorSelection =
  | { readonly tag: "ring"; readonly index: number }
  | { readonly tag: "stream"; readonly index: number }
  | { readonly tag: "state" }

export const devInspectorState = $state<{ selection: DevInspectorSelection | null }>({
  selection: null,
})

export const selectRingEntry = (index: number): void => {
  devInspectorState.selection = { tag: "ring", index }
}

export const selectStreamEntry = (index: number): void => {
  devInspectorState.selection = { tag: "stream", index }
}

export const selectShopState = (): void => {
  devInspectorState.selection = { tag: "state" }
}

export const clearSelection = (): void => {
  devInspectorState.selection = null
}
