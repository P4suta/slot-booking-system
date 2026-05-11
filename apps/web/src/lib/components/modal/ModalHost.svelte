<script lang="ts" generics="State extends { readonly tag: string }">
  /**
   * ModalHost — the rendering side of the `ModalState` ADT (S19 /
   * ADR-0087). The consumer holds a single `State` value (one of the
   * discriminated-union variants in `./states.ts`); this host inspects
   * `state.tag` and either renders nothing (`"none"`) or wraps a
   * `Dialog` and re-renders the children snippet with the *narrowed*
   * state value, so the consumer's `{#if state.tag === "..."}` branches
   * type-check exhaustively.
   *
   * The 2^N modal-flag combinatorial explosion of the pre-refactor
   * pages collapses to N+1 named variants here.
   */
  import type { Snippet } from "svelte"
  import Dialog from "../Dialog.svelte"

  type Props = {
    state: State
    title: string
    onClose: () => void
    children?: Snippet<[State]>
  }

  let { state, title, onClose, children }: Props = $props()
</script>

{#if state.tag !== "none"}
  <Dialog open={true} {title} {onClose}>
    {#if children}{@render children(state)}{/if}
  </Dialog>
{/if}
