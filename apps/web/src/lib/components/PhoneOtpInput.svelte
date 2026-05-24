<script lang="ts">
  import { tick } from "svelte"
  import type { FullAutoFill } from "svelte/elements"
  import { m } from "$lib/messages.js"

  type Props = {
    value: string
    label?: string
    autocomplete?: FullAutoFill
  }

  let { value = $bindable(""), label = m.phone_input_label(), autocomplete = "off" }: Props =
    $props()

  const SLOTS = 4 as const
  let inputs: (HTMLInputElement | null)[] = $state(new Array(SLOTS).fill(null))

  /**
   * Re-derive the per-slot digit array from the bound `value`. The
   * parent owns `value`; we keep the four `<input>`s in lockstep
   * with it via this projection. Any non-digit character is dropped
   * (e.g. paste of `1-234` reduces to `1234`).
   */
  const digits = $derived.by(() => {
    const cleaned = value.replace(/\D/g, "").slice(0, SLOTS)
    return Array.from(
      { length: SLOTS },
      (_, i): string => cleaned[i] ?? "",
    )
  })

  /**
   * Index of the first not-yet-filled slot, or -1 when all four are
   * filled. Slots strictly after this index are not yet reachable —
   * we disable them so the operator (or the customer) cannot click
   * into "the 3rd digit box" and start typing there, which used to
   * leave gaps in the middle (e.g. `_ _ 7 _`) and silently emit a
   * 3-char value upstream. Already-filled slots remain editable so
   * the customer can correct an earlier typo.
   */
  const firstEmptyIdx = $derived(digits.findIndex((d) => d === ""))
  const isSlotLocked = (i: number): boolean =>
    firstEmptyIdx !== -1 && i > firstEmptyIdx

  const focusSlot = async (idx: number): Promise<void> => {
    if (idx < 0 || idx >= SLOTS) return
    await tick()
    inputs[idx]?.focus()
    inputs[idx]?.select()
  }

  /**
   * Reject the character before it lands in the input. `onbeforeinput`
   * fires synchronously with `event.data` set to the to-be-inserted
   * string; calling `preventDefault()` cancels the insertion. On
   * desktop the user never sees a non-digit flicker; on mobile the
   * numeric keypad is doing its own filtering already.
   *
   * `inputType === "insertFromPaste"` is allowed through — paste is
   * handled in `onPaste` (multi-char distribution). Composition events
   * (IME) for digit input are equally allowed through.
   */
  const onBeforeInput = (event: InputEvent): void => {
    if (event.inputType === "insertFromPaste") return
    if (event.data === null || event.data === "") return
    if (/^\d+$/.test(event.data)) return
    event.preventDefault()
  }

  const onInput = (idx: number, event: Event): void => {
    const el = event.currentTarget as HTMLInputElement
    const raw = el.value.replace(/\D/g, "")
    if (raw.length === 0) {
      // Deletion via input event (mobile keyboards)
      const next = digits.slice()
      next[idx] = ""
      value = next.join("")
      return
    }
    if (raw.length === 1) {
      const next = digits.slice()
      next[idx] = raw
      value = next.join("")
      if (idx < SLOTS - 1) void focusSlot(idx + 1)
      return
    }
    // Paste of multiple digits — distribute across slots starting at idx.
    const slots = digits.slice()
    let cursor = idx
    for (const ch of raw) {
      if (cursor >= SLOTS) break
      slots[cursor] = ch
      cursor += 1
    }
    value = slots.join("")
    void focusSlot(Math.min(cursor, SLOTS - 1))
  }

  const onKeydown = (idx: number, event: KeyboardEvent): void => {
    if (event.key === "Backspace") {
      const el = event.currentTarget as HTMLInputElement
      if (el.value === "" && idx > 0) {
        event.preventDefault()
        const next = digits.slice()
        next[idx - 1] = ""
        value = next.join("")
        void focusSlot(idx - 1)
      }
      return
    }
    if (event.key === "ArrowLeft" && idx > 0) {
      event.preventDefault()
      void focusSlot(idx - 1)
      return
    }
    if (event.key === "ArrowRight" && idx < SLOTS - 1) {
      event.preventDefault()
      void focusSlot(idx + 1)
    }
  }

  const onPaste = (idx: number, event: ClipboardEvent): void => {
    const pasted = event.clipboardData?.getData("text") ?? ""
    const cleaned = pasted.replace(/\D/g, "")
    if (cleaned.length === 0) return
    event.preventDefault()
    const slots = digits.slice()
    let cursor = idx
    for (const ch of cleaned) {
      if (cursor >= SLOTS) break
      slots[cursor] = ch
      cursor += 1
    }
    value = slots.join("")
    void focusSlot(Math.min(cursor, SLOTS - 1))
  }

  /**
   * Click on a filled slot = "edit from here". Truncate value at this
   * index so the clicked slot becomes the new first-empty and every
   * downstream slot is discarded. The user typed something wrong
   * earlier; rather than fiddling with individual digits they just
   * re-enter from the offending position forward. Keyboard tab does
   * NOT trigger this (no click event), so navigating across already-
   * filled slots stays non-destructive.
   */
  const onClickSlot = (idx: number, event: MouseEvent): void => {
    // Empty / first-empty slot: ordinary click, nothing to discard.
    if (digits[idx] === "") return
    event.preventDefault()
    value = digits.slice(0, idx).join("")
    void focusSlot(idx)
  }
</script>

<fieldset>
  <legend>{label}</legend>
  <div class="slots">
    {#each digits as digit, i (i)}
      <input
        bind:this={inputs[i]}
        type="tel"
        inputmode="numeric"
        pattern="[0-9]"
        maxlength="1"
        autocomplete={i === 0 ? autocomplete : "off"}
        value={digit}
        disabled={isSlotLocked(i)}
        onbeforeinput={onBeforeInput}
        oninput={(e) => onInput(i, e)}
        onkeydown={(e) => onKeydown(i, e)}
        onpaste={(e) => onPaste(i, e)}
        onclick={(e) => onClickSlot(i, e)}
        aria-label={m.phone_input_digit_aria({ position: String(i + 1) })}
      />
    {/each}
  </div>
</fieldset>

<style>
  fieldset {
    border: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  legend {
    font-weight: 500;
    font-size: 0.9rem;
    margin-bottom: 0.4rem;
    padding: 0;
  }
  .slots {
    display: flex;
    gap: 0.6rem;
    justify-content: flex-start;
  }
  input {
    width: 3rem;
    height: 3.5rem;
    text-align: center;
    font-size: 1.5rem;
    font-weight: 500;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-raised);
    padding: 0;
    /* iOS / macOS Safari: numbers spinner suppression */
    -moz-appearance: textfield;
    appearance: textfield;
  }
  input::-webkit-outer-spin-button,
  input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  /* Locked slot: not yet reachable in the sequential entry flow. The
   * default disabled styling is functional but hard to distinguish
   * from an empty editable slot; tone it down so the eye lands on
   * the first-empty (editable) slot instead. */
  input:disabled {
    background: var(--color-bg-subtle);
    color: var(--color-border-strong);
    cursor: not-allowed;
  }
  input:focus {
    outline: 2px solid var(--color-border-focus);
    border-color: transparent;
  }
</style>
