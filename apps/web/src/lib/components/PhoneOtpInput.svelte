<script lang="ts">
  import { tick } from "svelte"
  import type { FullAutoFill } from "svelte/elements"

  type Props = {
    value: string
    label?: string
    autocomplete?: FullAutoFill
  }

  let { value = $bindable(""), label = "電話番号末尾4桁", autocomplete = "off" }: Props = $props()

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

  const focusSlot = async (idx: number): Promise<void> => {
    if (idx < 0 || idx >= SLOTS) return
    await tick()
    inputs[idx]?.focus()
    inputs[idx]?.select()
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
        oninput={(e) => onInput(i, e)}
        onkeydown={(e) => onKeydown(i, e)}
        onpaste={(e) => onPaste(i, e)}
        aria-label={`末尾4桁の${i + 1}桁目`}
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
    border: 1px solid #d2d2d7;
    border-radius: 12px;
    background: white;
    padding: 0;
    /* iOS / macOS Safari: numbers spinner suppression */
    -moz-appearance: textfield;
  }
  input::-webkit-outer-spin-button,
  input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  input:focus {
    outline: 2px solid #0071e3;
    border-color: transparent;
  }
</style>
