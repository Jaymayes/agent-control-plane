# My kill switch has never once fired

**Failure autopsy #2.** I built a hard spending cap on autonomous AI, wrote it into my own skills inventory as "operational, not designed-on-paper," and shipped it. It has blocked exactly zero calls, ever. This is what I found when I went looking for why.

All figures are from live queries against the production database and repository history, re-verified 25 August 2026. Queries included.

The timeline, since it matters later: the cap first appears in the codebase on **2 April 2026**. The first row lands in its ledger on **15 March 2026**. It became real enforcement rather than telemetry on **28 June 2026**. So: roughly five months of existing, two months of actually being wired to block something — and zero blocks.

---

## What I believed

Every autonomous system that can spend money needs a ceiling it cannot cross. Mine is a FinOps kill switch: before any paid inference, check today's accrued spend against a hard daily cap; if the cap is hit, block the call and set a sticky flag so nothing straddles the boundary.

I believed this was working, and I said so publicly. My own capability inventory described it as a "hard cost governance over autonomous LLM spend — operational, not designed-on-paper." That phrase was written to distinguish it from the sort of control that exists on an architecture diagram and nowhere else.

## Finding one: it was the thing it claimed not to be

An audit of my own code found the original implementation was telemetry, not enforcement. The header comment I wrote when fixing it is the most direct version:

> the "$5/day kill-switch" was telemetry only — `callAI()` fired inference unconditionally and nothing wrote cost, so the cap could neither accrue nor trip

Read that carefully, because it's two failures stacked. Nothing wrote spend, so the accumulator stayed at zero. And nothing checked before calling, so even a non-zero accumulator wouldn't have stopped anything. The cap could neither **accrue** nor **trip**. It was a number in a config and a figure on a dashboard.

The fix landed 28 June 2026 as a real pre-call gate — `06e6b56 feat(finops): Phase 2 — real pre-call AI spend kill-switch (not telemetry)`. Pure decision function, 12 tests, enforcement wired ahead of the provider call, spend accrued atomically after it.

## Finding two: the fix had a floor under it

On 17 August I lowered the cap from $5.00/day to $0.32/day, sized so 31 days stays under the $10/month ceiling my provider actually enforces. $5/day permitted roughly $150/month — about 15× the real limit — which made my own gate the looser of the two and effectively non-binding.

Lowering the constant would not have lowered the cap. The table's column definition is:

```sql
hard_cap_usd REAL NOT NULL DEFAULT 5.00
```

The accrual statement didn't write that column, so every new day's row silently inherited `5.00` from the schema. The code constant was decorative for any day that hadn't been created yet. The fix was to write `hard_cap_usd` explicitly on insert so the code is the single source of truth — and to leave existing rows alone on conflict, so a cap set deliberately for a given day isn't overwritten mid-day by an accrual.

## Finding three: the same defect was still there five days ago

While writing this post I found a third instance of the identical pattern — a bare `5` that no longer meant anything. In the gate's error path:

```js
return { allowed: true, reason: 'ok', spentUsd: 0, capUsd: 5 };
```

That's the fail-open branch: if the spend store can't be read, allow the call rather than take all inference down over a database blip. Nothing is mis-enforced there, because nothing is enforced at all. But the `429` response body reported a `$5` ceiling that had been `$0.32` since August, misstating it by about 15×. I fixed it on 22 August, four months after the constant moved, by returning `null` — on a path that enforces nothing, "unknown" is honest and a stale number is not.

Three instances of one defect: a literal that was true when written, in a system where the truth moved.

## Finding four: the part I didn't expect

Having fixed all that, I went to look at how often the gate had actually fired. The whole table:

```sql
SELECT COUNT(*) AS days, ROUND(SUM(total_spend_usd),4) AS total_spend,
       SUM(call_count) AS total_calls, SUM(kill_switch_hit) AS trips
FROM daily_billing_caps;
-- days: 2   total_spend: 0.006   total_calls: 6   trips: 0
```

**Two rows. Ever.** One from 15 March 2026 — six calls, six tenths of a cent. One from 18 April — zero calls, zero spend. Nothing since. No May, June, July, or August. Zero trips, all time.

This is not a bug, and that's the uncomfortable part. Paid inference accrues; Cloudflare Workers AI at the edge is priced at zero in my cost model and returns early without writing a row. My content pipeline runs on Workers AI. So an empty table is the *correct* output of a system that hasn't made a paid call in months — which matches my measured AI spend of approximately zero.

But it means the enforcement path has never executed in production. Not once. Twelve unit tests cover the decision function, and they pass. The integration — accrue, cross the threshold, set the sticky flag, block the next call, return a terminal 429 — has never run outside a test. **I have a safety control I have never seen work.**

There's also a row that needed explaining: 18 April carries `hard_cap_usd = 50`, ten times the then-default of `5.00`, with zero calls against it.

Its `created_at` and `updated_at` are identical to the second — `2026-04-18 01:06:28` — and `call_count` is 0. An accrual would have moved both. So nothing ever ran against this row; it was inserted directly with an explicit cap and then left alone.

Nothing in the repository writes `hard_cap_usd = 50`, so it wasn't code. What the repository does show is what I was doing that night: the commits either side of that timestamp are all live voice work — Twilio signature validation, a Gemini Live transcoder, an outbound call script, and one titled *"launch terminal war-room for live-fire phone call."*

The obvious reading is that I raised the ceiling tenfold by hand before a live demo so the gate couldn't interrupt it, then never spent through that path. I can't prove it — a manual `wrangler d1 execute` leaves no trace in git — but the timestamp, the untouched counters, and the explicit non-default value all point the same way, and I have no competing explanation.

It's inert now: the gate only reads the row matching today's date, and since the August fix the code writes `hard_cap_usd` explicitly on every insert, so a stale 50 can never apply to a new day. Worth recording anyway, because **"I raised the limit temporarily and forgot" is exactly the failure mode a hard cap exists to prevent**, and it happened to me inside the system I built to stop it.

## What I was wrong about

**I called it operational when it was telemetry.** Not maliciously — I believed it. But "operational" is a claim about runtime behaviour, and I had never checked runtime behaviour. I'd checked that the code existed.

**I fixed the constant and thought I'd fixed the cap.** The schema default sat underneath the code, silently winning for every new day. A configuration value has as many sources of truth as it has places it can be defaulted, and I only knew about one of them.

**I treated "the tests pass" as "the control works."** The tests do pass, and they test the right thing — a pure function that decides correctly given a state. What they cannot tell me is whether the state ever arrives. A gate whose input never populates is a gate that always says yes, and every test in the suite would still be green.

**And I never asked how often it had fired.** That question would have surfaced all of the above in about ninety seconds, at any point in the five months this thing has existed. It's a single `COUNT(*)`. I wrote the dashboards, the tests, the fix, and the follow-up fix, and I did not once ask the system what it had actually done.

I'll add that "fourteen months" is what I first wrote there, from memory, before checking. The real span is five. Even the sentence admitting I never checked a number contained a number I hadn't checked.

## The part that generalises

If you run autonomous agents with a spending ceiling, three questions are worth more than reading the code:

1. **Has it ever fired?** Not "is it wired up" — has the blocking branch executed in production, ever? If the answer is no, you have an untested control, regardless of test coverage.
2. **Where else can this number come from?** Code constant, schema default, environment variable, a row somebody set by hand in April. Each is a source of truth, and the lowest one usually wins.
3. **What happens when the store is unreachable?** Fail open or fail closed is a real decision with real consequences, and it should be a written policy, not whatever the catch block happened to return.

I'm not changing the fail-open posture on the interactive path — a database blip shouldn't take live inference down, and my background workers already fail closed. That split is deliberate. What I'm changing is that I now know it's a decision, rather than assuming it was one.

The cap is $0.32/day. It has never stopped anything. I still don't know that it would.

---

*Second in a series of failure autopsies from Sovereign OS — a governed autonomous content system I built and run solo. Each states what I believed, what the instrument showed, and what I was wrong about. None of them are success stories.*

---
