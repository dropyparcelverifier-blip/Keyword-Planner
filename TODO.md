# KP Death Spiral Fix

## Root cause (corrected)

The earlier diagnosis — "R1 reads R2's counter" — was a symptom, not the cause.

The actual cause: **the dead-streak counter's only reset path was gated behind
the thing the counter disables.**

- The counter armed at 2 and switched on the R2 KP auto-skip.
- The auto-skip set `kp1ForR2.length = 0`, so `totalKp1 === 0`.
- The reset branch was guarded by `if (totalKp1 > 0)` — unreachable.

So once the counter hit 2 it could never come down. Every following SKU
skipped KP, produced no rows, bumped the counter again, and was marked
FAILED — on workers whose Google Ads session was perfectly healthy.

Two things made it worse:
- The auto-skip emitted `⚠ KP FAILED: r1_kp_skipped_auto`, which the
  background.js circuit breaker regex-matched as a real failure. The skip fed
  the breaker that caused the skip.
- The breaker's input was a **log string**, not an event, so a deliberate skip
  and a genuine failure were indistinguishable.

## Fix — one counter, four invariants

Single source of truth in `modules/keyword-discovery.js`
(`KP_DEAD_STREAK_KEY`, `readKpDeadStreak` / `bumpKpDeadStreak` /
`armKpDeadStreak` / `resetKpDeadStreak`, `isKpSessionDeadError`):

- [x] **One key.** `adbrainKpDeadStreak` replaces `adbrainR1DeadStreak` +
      `adbrainR2DeadStreak`. Legacy keys are read once, **discarded** (not
      migrated) and deleted — so upgrading un-wedges a stuck worker.
- [x] **It expires.** 30-min TTL enforced on read. A stale flag can never
      outlive the session problem that set it, even with zero successes.
- [x] **The reset path is always reachable.** A successful **Round 1** KP
      resets it. Round 1 always runs; Round 2 is what the counter disables.
- [x] **A skip is not a failure.** `kpResult.skipped` + typed
      `kpEvent: 'skipped'`; the skip no longer emits the KP-FAILED line, and a
      zero-yield SKU only bumps the counter when KP was actually attempted.
- [x] Counter is capped (10) so it can't run away.
- [x] background.js breaker keys off typed `payload.kpEvent`, with the old
      regex kept only as a fallback for pre-`kpEvent` payloads.
- [x] `isKpCooldownActive()` clears `consecutiveKpFailures` + the streak keys
      when the cooldown expires, so the retry isn't re-tripped instantly.
- [x] One `isKpSessionDeadError()` predicate replaces three drifting regex
      copies that disagreed about which errors counted.

Pinned by `KP-SPIRAL.1`–`.15` in `scripts/regression-test.mjs`.

## Deliberately NOT done

- **Website-fallback on R1 skip.** Proposed earlier, but `KP_GET_IDEAS_WEBSITE`
  drives the same Google Ads UI we're skipping *because it's broken* — it would
  reintroduce the per-SKU cost the skip exists to avoid.
- **Mark 0-row products as `zero_keywords` failed.** This adds another path to
  FAILED while the live complaint is that everything is already landing there.
  The existing fail-fast already covers the genuinely-empty case. Revisit once
  the fleet is confirmed healthy.

## Follow-up worth considering

- `background.js` derives the worker ID from a 24-bit hash of hostname/MAC.
  Stable, but ~0.03% collision risk at 100 PCs, and a collision means two PCs
  share a fleet identity. Using the sanitized hostname directly would be
  collision-free and easier to debug.
