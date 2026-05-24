# ADR-0081: Looping called-chime + acknowledge button

- Status: accepted
- Date: 2026-05-24
- Refines: ADR-0072 (overdue state + nudge loop) — audio playback
  layer only; the `(calledAt, nudgeCount)` dedup invariant is
  preserved unchanged.
- Touches: ADR-0073 (web-push channel) — push remains the
  out-of-tab transport; this ADR upgrades the in-tab foreground
  signal.

## Context

ADR-0072 introduced a foreground alert on the customer's `/ticket`
page: when the WS-driven refresh observed the ticket entering
`Called` or receiving a fresh `Nudged` event, three signals fired —
a Web Audio chime, a `navigator.vibrate` pattern, and a browser
notification. The chime was a two-tone burst (A5 → E6, ~500 ms
total) and was fire-and-forget: scheduled on a fresh `AudioContext`
that closed itself 800 ms later.

Customer feedback after a real shift: the ~500 ms chime is **too
short to register** when the phone is on the table and the customer
is looking elsewhere. Re-firing on each Nudge helps, but Nudge is
ADR-0072-rate-limited (one per `OVERDUE_TICK_MS`) so the audio
opportunity arrives at most once every 30 s. The vibrate +
notification signals are still present, but a customer with a muted
phone in a quiet waiting room only has the chime to count on.

The two-tone burst was also impossible to *cancel*: once the
oscillators were scheduled the only thing the page could do was let
them play out. Any "stop noise" affordance is a no-op in that model.

## Decision

Move the audio loop into a new `chimeController` module
(`apps/web/src/lib/chimeController.ts`). The customer-facing
contract becomes:

1. Every alert fire (Called *or* a fresh Nudge) starts (or restarts)
   a **loop** of a 1.5 s five-tone pattern — four short 880 Hz pulses
   followed by one longer 1318 Hz tone — with a 0.5 s silence
   between cycles. The loop runs for up to `CHIME_TIMEOUT_MS`
   (15 s) before auto-silencing.
2. While the loop is running, `/ticket` renders an inline
   「確認しました」button. Tapping it calls `chimeController.stop()`
   which closes the active `AudioContext` and clears both the cycle
   and timeout timers — the chime stops within milliseconds.
3. A second fire while the loop is still running (e.g. an early
   Nudge) **swaps the underlying AudioContext** (close + create new)
   but keeps the on-screen `playing = true` flag steady — the
   acknowledge button does not unmount and re-mount, so a customer
   who is mid-tap does not lose the press.

The dedup layer in `calledAlert.ts` is unchanged: the localStorage
key `queue.lastNotifiedCalledAt` still maps to `(calledAt, nudgeCount)`
and the trigger guard still no-ops on a duplicate observation. The
only edit to `calledAlert.ts` is replacing the inline `playChime()`
call with `chimeController.start()`. `vibratePattern()` and
`showNotification()` remain one-shot per fire — only audio loops.

`chimeController` is a plain TypeScript module with module-level
state, not a Svelte 5 rune store. The web app's vitest config runs
`environment: "node"` with no svelte preprocessor wired in (see
`apps/web/vitest.config.ts`), so a `.svelte.ts` file would crash at
import time in tests. The `/ticket` page mirrors the controller's
`isPlaying()` flag into a local `$state` via `subscribe()` and
unsubscribes on `onDestroy`.

## Consequences

**Positive:**

- The customer is significantly more likely to notice the call —
  a 15 s loop in a 5-tone pattern is hard to miss compared to a
  500 ms two-tone burst.
- The looping chime gives the customer a tactile control — tap
  「確認しました」to silence — instead of being subjected to whatever
  the alert wants to do.
- The dedup layer is unchanged, so existing properties
  (Recall → re-Call mints a fresh `calledAt`, Nudged in `Overdue`
  bumps `nudgeCount`) keep their established semantics.
- Restart-while-running preserves the ack button across rapid
  re-fires (Nudge → Nudge in quick succession), avoiding a flicker
  that would risk the button being unmounted under the customer's
  finger.

**Negative / accepted:**

- A 15 s loop in a quiet waiting room is more disruptive than a
  single 500 ms chime — for the customer themselves, and for nearby
  patrons. We accept that disruption in exchange for the customer
  not missing the call. `CHIME_TIMEOUT_MS` is a single-constant
  knob if field experience says the duration should change.
- Multiple tabs of the same `/ticket` will each run the loop
  independently (the dedup key is `localStorage`-shared, so only
  one tab actually triggers per event, but each tab's controller is
  its own singleton). Cross-tab silence-coordination via
  `BroadcastChannel` is **explicitly out of scope** — the typical
  customer has one tab open and the cost-to-benefit on the
  multi-tab case is poor.
- AudioContext autoplay policy (Chrome on Android, iOS Safari) may
  still leave the loop silent until the customer touches the page —
  the vibrate + notification signals cover that window. The
  acknowledge button is rendered regardless, so the customer can
  always silence the (locked) controller manually.

**Out of scope:**

- Visual indicator of remaining loop time (a 15 s countdown bar
  inside the button). Adds UI weight for marginal value; can be
  added later as a non-breaking enhancement.
- Per-nudge escalation (more aggressive sound on the 2nd, 3rd
  Nudge). The current decision is uniform-loudness with the same
  loop every fire. Escalation is a one-line tweak inside
  `chimeController` if the field calls for it.

## Implementation

Touched paths:

- `apps/web/src/lib/chimeController.ts` — **new**. The looping
  controller. Module-level `playing` flag, `running` record
  (active ctx + cycle timer + timeout timer), `start` / `stop` /
  `isPlaying` / `subscribe` exports.
- `apps/web/src/lib/calledAlert.ts` — `playChime()` removed; the
  trigger calls `chimeController.start()` instead. `vibratePattern`
  and `showNotification` unchanged.
- `apps/web/src/routes/ticket/+page.svelte` — `chimePlaying` local
  state subscribed in `onMount`, unsubscribed and stopped in
  `onDestroy`, terminal-state branch calls
  `chimeController.stop()`. New 「確認しました」button mounted
  inside the existing `Waiting | Called | Overdue` block via
  `{#if chimePlaying}`.
- `apps/web/messages/{ja,en}.json` — new
  `ticket_chime_acknowledge_button` key (`"確認しました"` /
  `"Acknowledge"`); paraglide compile picks it up via
  `pnpm run paraglide`.
- `apps/web/test/chimeController.test.ts` — **new**. Stubs
  `window.AudioContext`, uses `vi.useFakeTimers()`, covers: single
  cycle (5 osc), loop continuation (`+5` per `+2 s`), auto-stop at
  15 s, `stop()` close+notify, idempotent `stop()`, no-op `stop()`
  before `start()`, `start()`-while-running ctx swap without
  flicker, timeout reset on restart, subscribe / unsubscribe
  lifecycle, AudioContext-unavailable fallback.
- `apps/web/test/calledAlert.test.ts` — oscillator-count assertions
  updated from `2` / `2 * 4` to `5` / `5 * 4`; `vi.useFakeTimers()`
  + `chimeController.stop()` added to lifecycle hooks so the loop
  timers do not leak across tests.

Adversarial probes still expected at the boundary:

- A Recall → re-Call cycle (fresh `calledAt`, `nudgeCount = 0`)
  starts a new 15 s loop.
- Three rapid Nudges (`nudgeCount = 1, 2, 3`) keep the loop
  continuously running with a fresh 15 s timeout on each fire — the
  ack button stays mounted across all three.
- Terminal-state observation (`Served` / `Cancelled` / `NoShow`)
  silences the loop in the same `refresh()` pass that purges the
  ticket cache.
- Page unmount silences the loop via `onDestroy`.
