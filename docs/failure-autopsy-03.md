# For 35 days my publish hook did nothing, successfully

**Failure autopsy #3.** Every time I approved an article, my system pinged IndexNow to tell search
engines a new page existed. It returned `200`. It logged no errors. It had never once run.

All figures below are from the live code, the production database, and repository history, verified
5 September 2026 and re-verified against the source on 9 September before publishing. Where a number
is not recoverable, I say so instead of estimating.

The window: the hook was committed **2026-07-31**, and the missing configuration was found and
fixed **2026-09-04**. Thirty-five days.

---

## What I believed

When I approve a piece of content, it goes live at a public URL. Search engines find it eventually
via the sitemap, but IndexNow is a push protocol — you tell Bing, Yandex, DuckDuckGo and others
directly, and discovery drops from days to minutes. So I wired it into the approval handler. Approve
an article, ping IndexNow, done.

I checked that the code existed. I did not check that it ran. If that sounds familiar, it is the
same sentence I wrote in autopsy #2 about a spending cap, five weeks earlier, and I want to be clear
that knowing the lesson did not stop me repeating it.

## Finding one: the first line of the function is the whole story

```js
async function submitToIndexNow(env, urlList) {
  const key = env.INDEXNOW_KEY;
  if (!key || !Array.isArray(urlList) || urlList.length === 0) return;
```

`INDEXNOW_KEY` was never set on the deployed worker — the secret list did not contain it. So every
call since the hook was added returned at the guard clause, having done nothing at all. (The list
carries 22 entries today, including that one.)

Nothing about that is a bug. That guard is correct and I would write it again. It is *supposed* to
degrade quietly when the integration is not configured, so that a missing optional secret doesn't
take down the approval path.

## Finding two: I wrote the failure mode down, at the top of the function, and shipped it anyway

The comment directly above the code says:

> No-op if `INDEXNOW_KEY` is unset. Never throws into the request path (fire via `ctx.waitUntil`).

That is an exact description of what went wrong, written by me, five weeks before I noticed it had
gone wrong. It reads as a design note. It is also a complete incident report, and it sat in the
file the entire time.

The call site is wrapped in `ctx.waitUntil(...)` — the promise is handed to the runtime and detached
from the response. The function's own `catch` downgrades any failure to `console.warn`. So there are
three independent layers of silence stacked here: the guard returns early, the detached promise means
nothing awaits a result, and the catch converts errors to warnings. Each is individually defensible.
Together they make it structurally impossible for a failure to reach anything I look at.

The approve endpoint returned `200` every single time, and it was telling the truth. Approval
succeeded. It just wasn't claiming anything about the ping, and I read it as though it were.

## Finding three: the one check that would have caught this was disabled by the same bug

IndexNow requires you to prove you own the domain by serving a key file at a public URL. My worker
serves that file:

```js
if (env.INDEXNOW_KEY && method === 'GET' && url.pathname === `/${env.INDEXNOW_KEY}.txt`) {
```

Read the condition. The verification route is gated on **the same unset secret**. With no key set,
the key file 404s — so the one externally observable signal that would have revealed the
misconfiguration was itself switched off by the misconfiguration.

This is the finding I would most want someone else to take away, because it is not a typo and it is
not laziness. It is a shape. When a feature and its own health check read the same config value, a
missing value doesn't produce a broken feature and a failing check. It produces a silent feature and
a silent check, and the system presents as healthy. **A monitor that shares a dependency with the
thing it monitors is not a monitor.**

## Finding four: I cannot tell you how many pings were lost

I wanted to open this post with a number — *N articles approved, N pings dropped*. I can't, and
finding out why was its own small lesson.

Neither table records when approval happened. The content table stores `created_at`, which is set
when the row is staged, and status is later mutated in place by the approve handler:

```sql
UPDATE published_content SET status = ? WHERE id = ?
```

No `approved_at`. No status-change log. The approval queue table has the same shape — `created_at`
and a mutable `status`, nothing else. So the event I want to count leaves no trace: the row that
records it is overwritten by it.

The part that stings is that I already knew how to do this. A different table in the same file, for a
different kind of approval, is updated like this:

```sql
UPDATE orchestrator_missions SET status = 'approved', approved_by = ?, approved_at = datetime('now') ...
```

Same codebase, same author, same week's worth of thinking — `approved_by` and `approved_at` both
recorded. So this isn't a gap in what I know about schema design. It's a gap in which tables I
thought were worth auditing, and I picked the wrong one to be careless with: the mission table logs
approvals nobody needed to count, and the content table, which drives everything public, logs none.

The closest honest proxy is that **34 content rows were created during the 35-day window**, which
bounds the scale without answering the question, because staging and approval are different events
on different days. My own memory notes claimed "47" in one paragraph and "43" in another. Both were
written from recollection, they disagree with each other, and neither is recoverable from the
database. I've corrected them to say the count is unknown.

An unobservable action turns out to also be an uncountable one. That is not a coincidence — the same
missing instrumentation causes both.

## What I was wrong about

**I treated `200` as evidence about something it never described.** The response was about whether
the approval committed. I read it as though it covered everything the handler did, including work
that had been explicitly detached from the response before it was sent.

**I confused "cannot fail loudly" with "will not fail."** Fail-soft is a good property. It is not a
property that makes the thing work, and I had built three layers of it around an integration I had
never once seen succeed.

**I already knew this.** Autopsy #2 ended with "has it ever fired?" as the first question worth
asking about a control. I wrote that on 28 August. This defect had been live for four weeks at that
point, in the same file, about 850 lines above the budget gate that post was about. Writing the
lesson down is not the same as running it against everything else you own.

## The part that generalises

If you have fail-soft integrations — analytics, webhooks, search pings, notification hooks, anything
fired from `waitUntil` or a floating promise — three questions:

1. **Has it run once?** Not "is it wired up," not "did the deploy succeed." Has this specific code
   path produced a real effect in production, ever? A `console.log` on the success branch and one
   grep of the logs would have closed this in under a minute, at any point in 35 days.
2. **Does its health check share a dependency with it?** If the same unset variable disables both the
   feature and the signal that the feature is off, you have no signal. Check that the probe fails
   *loudly* in the exact scenario the feature fails *quietly*.
3. **Would you be able to count the damage afterwards?** Mutating a status column in place destroys
   the timestamp of the transition. If the event matters, record that it happened, not just the state
   it left behind.

The general form: **an operation that cannot fail loudly needs a positive check that it happened,
not an absence of errors.** Absence of errors is the default output of code that never ran.

## What fixing it actually bought me

Close to nothing, and saying so is the point.

The key is set, the file now serves `200 text/plain` on both hosts, and a live submission returned
`202 Accepted`. The integration works, five weeks late.

But **Google does not support IndexNow** — it never has, and this was documented in my own comment
above the function the whole time. Google discovery runs off the sitemap, which was working. And
per Search Console, my constraint isn't discovery at all: the review pages are indexed, they collect
impressions, and they sit at an average position deep enough that almost nobody clicks. Ranking is
the problem. Being found faster by Bing does not touch it.

So this is a five-week-old silent failure in a system that supplements a channel that wasn't broken,
serving engines that aren't my traffic. Fixing it is correct. Filing it as progress would be a
second, worse error than the original one — and given that I write these posts partly to have
something to show, that was a real temptation worth naming.

The honest summary is that I found a control that had never executed, in the same file where I had
just published an essay about finding a control that had never executed. The value is in the shape,
not the ping.

---

*Third in a series of failure autopsies from Sovereign OS — a governed autonomous content system I
build and run solo. Each states what I believed, what the instrument showed, and what I was wrong
about. None of them are success stories.*
