import { describe, it } from "vitest"

// TODO(diagnose-train): unskip in F8 — pin idempotency for all 6
// TicketEvent tags via fast-check (Issued is `Map.set`-idempotent;
// the others are guarded by prior-state checks so a repeated apply
// is a no-op).
describe("applyEvent idempotency (property)", () => {
  it.todo("applyEvent(s, e) deepEquals applyEvent(applyEvent(s, e), e)")
})
