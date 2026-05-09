/**
 * Resolve the per-property `numRuns` for fast-check assertions.
 *
 * Precedence:
 *
 *   1. `FC_NUM_RUNS` env (set by `scripts/fuzz/run-soak.sh` to
 *      10_000+ for the long-run fuzz soak).
 *   2. `CI=true` → the larger of the dev / CI defaults.
 *   3. dev default (the 2nd argument).
 *
 * Tests pass two integers — `dev` and `ci` — so the soak override
 * doesn't widen the dev-loop runtime by mistake. Returns a finite
 * positive integer; an unparsable env value falls through to the
 * CI / dev branches.
 */
export const numRuns = (dev: number, ci: number): number => {
  const fromEnv = Number(process.env.FC_NUM_RUNS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
  return process.env.CI === "true" ? ci : dev
}
