# agent-control-plane

Four gates for running LLM agents in production without hoping they behave.

Extracted from a governed autonomous content system that has been running on Cloudflare
Workers since 2025. Every gate here is enforcement, not telemetry — each one has an
`allowed: false` path that stops the thing from happening.

MIT licensed. No dependencies. Works on Workers, Node, Deno, or Bun.

---

## Why this exists

Most "AI governance" is a dashboard. Something logs a number, a chart goes up, and nothing
in the system is actually prevented from doing anything.

I know this because I shipped exactly that and did not notice for months. The commit message
in my own repo reads:

> the "$5/day kill-switch" was telemetry only — `callAI()` fired inference unconditionally and
> nothing wrote cost, so the cap could neither accrue nor trip.

A cap that cannot accrue and cannot trip is a decorative number. The gates in this package
are the corrected versions: pure decision functions with an explicit blocked state, plus the
storage contract needed to make them binding.

## The four gates

| Gate | Prevents | Failure posture |
|---|---|---|
| `budget` | A paid inference from being made once a spend ceiling is reached | Configurable — see below |
| `approval` | Machine-generated content from reaching the public without a human release | Fails closed |
| `disclosure` | Content publishing without required disclosures | Fails closed |
| `retraction` | A published item from staying live once flagged | N/A — always permits removal |

### 1. Budget gate

A pre-call ceiling. The decision function is pure, so it is testable without a database:

```ts
import { evaluateBudget, estimateCostUsd } from "agent-control-plane";

const decision = evaluateBudget({
  spentUsd: 0.30,
  capUsd: 0.32,
  killSwitchHit: false,
});
// → { allowed: true, reason: "ok", spentUsd: 0.3, capUsd: 0.32 }
```

Three things make this binding rather than decorative:

**It runs before the call, not after.** A gate that records spend after inference is an
invoice, not a ceiling.

**The cap is sticky.** Once spend crosses the cap, a `killSwitchHit` flag is set and stays
set for the window. Without this, spend that lands concurrently can straddle the boundary
and each individual call sees itself as under the cap.

**A non-positive cap falls back to the default, never to unlimited.** This is the single
most important line in the file:

```ts
const capUsd = Number(s.capUsd) > 0 ? Number(s.capUsd) : DEFAULT_HARD_CAP_USD;
```

A missing config value must not read as "no limit."

There is a fourth thing that is a real trap and worth stating plainly: **if you write the cap
into a database column with its own default, the code constant is no longer the source of
truth.** Lowering the constant then changes nothing for new rows. The upsert in
`examples/worker.ts` writes `hard_cap_usd` explicitly for that reason.

### 2. Approval gate

Machine-generated content stages as `pending` and requires an explicit human release. There
is no autonomous publish path — not a flag, not an env var, not an admin override.

```ts
import { evaluateRelease } from "agent-control-plane";

evaluateRelease({ status: "pending", releasedBy: null });
// → { allowed: false, reason: "awaiting_human_release" }

evaluateRelease({ status: "pending", releasedBy: "operator@example.com" });
// → { allowed: true, reason: "ok" }
```

The gate is deliberately boring. Its value is that it exists in the write path rather than in
a policy document.

### 3. Disclosure guard

Deterministic checks that run before publication — no model call, so they cannot be talked
out of it by a prompt.

```ts
import { checkDisclosures } from "agent-control-plane";

checkDisclosures(copy, { requireAd: true, requireAiGenerated: true });
// → { allowed: false, reason: "missing_disclosure", missing: ["ai_generated"] }
```

Run these as inverse guards: the content does not publish unless the required markers are
present. Asking a model to include a disclosure is a request. Checking for it is a control.

### 4. Retraction

One status flag takes a published item down everywhere, with no redeploy. This is the gate
people skip, and it is the one that matters when something goes wrong at 2am. If your
rollback path is a deploy, you do not have a rollback path.

---

## Failure posture: the decision you have to make consciously

When the gate itself cannot reach its store, does it allow or block?

**Fail-open** keeps the system running through a database blip, and treats the ceiling as a
backstop rather than a security boundary.

**Fail-closed** treats the ceiling as binding, and accepts that a store outage stops
inference entirely.

This package defaults to **fail-closed** and makes the alternative explicit:

```ts
evaluateBudgetOnStoreError(capUsd, { onStoreError: "allow" }); // opt in deliberately
```

The system this came from splits it deliberately: **interactive paths fail open, background
workers fail closed.** A user waiting on a response should not get a 500 because the spend
ledger blinked; a cron job at 3am with nobody watching should stop. That split is written down
at the top of the worker, next to the code, which is the only place a policy survives.

I recommend the same split, and this package makes you say which one you are in:

```ts
evaluateBudgetOnStoreError(cap, { onStoreError: "allow" }); // interactive
evaluateBudgetOnStoreError(cap);                            // background — default
```

The failure I would flag instead is subtler and I shipped it: the fail-open branch returned a
**hardcoded** cap figure in its error payload. When the real cap moved, that literal did not,
and the API cheerfully reported a ceiling ~15x higher than the enforced one. Nothing was
mis-enforced — the number was cosmetic — but anyone reading the 429 body was misinformed for
months. This package returns `capUsd: null` on that path, because reporting "unknown" is
honest and reporting a stale number is worse than reporting nothing.

Pick a posture per path. Write down why, next to the code. Then keep numbers out of comments
and error strings, where nothing forces them to stay true.

---

## Storage contract

The gates are pure. You supply the state. `schema.sql` has a reference D1/SQLite schema —
one table for the spend window, one for the approval queue.

The spend row must be updated atomically. The reference upsert flips the sticky switch in the
same statement that accrues the cost, so a concurrent write cannot slip past the boundary:

```sql
kill_switch_hit = CASE WHEN total_spend_usd + ?1 >= hard_cap_usd THEN 1 ELSE kill_switch_hit END
```

If you cache the gate decision (recommended — this runs on every inference), **invalidate the
cache on accrual**, not just on TTL expiry. Otherwise the tripped state is invisible for the
length of your TTL, which is exactly the window in which spend is running hottest.

---

## What this is not

- Not a prompt firewall, jailbreak filter, or content classifier.
- Not an eval harness.
- Not a policy engine with a rules DSL. Four gates, plain functions.
- Not a substitute for your provider's own spend limits. Set those too — and make sure the
  cheaper of the two ceilings is the one that binds. Mine did not for a while: a $5/day cap
  permitted roughly $150/month against a $10/month provider limit, which made the local gate
  non-binding in every month it mattered.

## Status

v0. Extracted from a running system, generalized, and re-tested in isolation. The originals
are in production; these versions are not yet, which is the honest distinction.

## License

MIT
