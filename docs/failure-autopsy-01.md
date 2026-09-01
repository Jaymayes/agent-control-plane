# For ten days, most of my click data was me

**Failure autopsy #1.** I spent five days building network theories to explain traffic that turned out to be my own auditor. Then, writing this up, I found that the reassuring sentence I'd drafted about it — the one saying the contamination was harmless — cited a database column that doesn't exist.

Every figure below was re-queried live on 24 August 2026. The queries are included.

---

## What I believed

My affiliate engine writes a row to a D1 table every time someone hits a `/go/:slug` redirect. That table is the closest thing I have to a demand signal — measured at the redirect, not sampled, not inferred from a third-party pixel.

Sitting in it was a large block of rows sharing one `ua_hash`: `2693f0f6d8498101`. Same hash, over and over, at a cadence no human produces.

My working theory was that something in the network path was replaying or prefetching my redirects. That's a reasonable prior — redirect endpoints get hit by link scanners, security software, prefetchers, CDN edge behaviour. I had two specific versions: HTTP/3 connection behaviour, and an antivirus link scanner on my own machine.

## What the instrument actually showed

Both were refutable, and both were refuted.

The HTTP/3 theory predicted the pattern would change when the transport changed. It didn't. The antivirus theory predicted the rows would stop when the scanner wasn't running. They didn't.

I then set up a bisect — a scheduled task to isolate the process by turning candidates off in sequence. It produced **zero usable samples**. Not an ambiguous result; no data at all. The scheduled task is still on that machine, and deleting it is the only artifact that investigation produced:

```
schtasks /delete /tn "SovereignOS-BatcherBisect" /f
```

Five days in, two dead hypotheses and an experiment that yielded nothing. What actually solved it took about four seconds of attention: the request timestamps correlated with **file writes in my own repository**.

Not network events. File writes. Something local was running, writing files, and hitting my endpoints in the same window.

`ua_hash` is an unsalted `sha8` of the User-Agent, so it's decodable by brute force if you can guess the input. I'd been hashing public User-Agent corpora against it for days. What I hadn't done was grep my own repository.

```
scripts/audit-live-pages.mjs:73
const UA = 'ReferralSvcLivePageAudit/1.0 (…; deterministic; no-referrer)'
```

My own live-page auditor. `npm run audit:live`. I wrote it. It has a hardcoded constant User-Agent, exactly as designed.

I also believed it ran on a schedule. It doesn't — but I only found that out later, and that turned out to be the third wrong thing in this post.

## The numbers, and why "half" needs a window

```sql
SELECT COUNT(*) AS total, COUNT(DISTINCT ua_hash) AS uas FROM affiliate_clicks;
-- total: 707   uas: 55

SELECT COUNT(*) FROM affiliate_clicks WHERE ua_hash = '2693f0f6d8498101';
-- 308
```

308 of 707 rows — **43.6%** — are my own auditor.

But that single percentage is misleading, and the way it's misleading is the actual lesson. The auditor didn't run across the whole table's life:

```sql
SELECT MIN(created_at), MAX(created_at) FROM affiliate_clicks WHERE ua_hash='2693f0f6d8498101';
-- 2026-08-08 12:39:50  →  2026-08-18 07:23:59
```

Ten days, then nothing. It has written no rows since 18 August. Inside its own active window:

```sql
SELECT COUNT(*) AS total, SUM(ua_hash='2693f0f6d8498101') AS auditor
  FROM affiliate_clicks
 WHERE created_at BETWEEN '2026-08-08 12:39:50' AND '2026-08-18 07:23:59';
-- total: 494   auditor: 308
```

**62%.** For those ten days, nearly two-thirds of my demand signal was a cron job I wrote.

So "half my click data is me" is true, false, or an understatement depending entirely on the window — 43.6% all-time, 62% while it ran, 0% since. **Any contamination ratio without a time window attached is a number you cannot act on.** I nearly published one.

## The claim I got wrong

My first draft of this post contained a reassuring paragraph. It said the auditor's rows carried `referred = 0`, that my reporting already excluded unreferred rows, and that the contamination therefore touched nothing I report.

**There is no `referred` column.** The query errors:

```
no such column: referred
```

The real schema is `click_id, slug, program, sub_id, ip_hash, ua_hash, referrer, utm, created_at`. I'd written a confident sentence about a column that has never existed, in a post about measurement honesty, and I only caught it because I ran the query instead of trusting the draft.

The nearest true statement is that all 308 auditor rows have `referrer IS NULL` — the no-Referer design does what it claims. But that does **not** isolate them:

```sql
SELECT CASE WHEN referrer IS NULL THEN 'NULL' ELSE 'HAS VALUE' END AS ref,
       COUNT(*) FROM affiliate_clicks WHERE ua_hash <> '2693f0f6d8498101' GROUP BY ref;
-- NULL: 353   HAS VALUE: 46
```

353 *non-auditor* rows are also referrer-null. Filtering on a null referrer would drop 661 of 707 rows — 93% of the table — and leave 46. That filter isn't the surgical exclusion my draft implied; it's a blunt instrument that happens to catch the auditor along with almost everything else.

So the honest version: **the contamination is bounded and identifiable, but the mechanism I claimed made it harmless doesn't do what I said.**

## And then it got worse

The draft's other reassurance was that auditor rows never touch `published_content.clicks` — the per-slug counter I actually report from. I checked that too. It's also false.

The auditor hits eight distinct slugs. Four are bare (`clickfunnels`, `getresponse`, `systeme-io`, `ghl-firstpromoter`), which match nothing. But four carry the hash suffix that real published pages use — `clickfunnels-f19e44e2`, `getresponse-34b2f721`, `gohighlevel-cc903022`, `systeme-io-293a8d85` — and those **do** exist in `published_content`.

```sql
SELECT COUNT(*) FROM affiliate_clicks ac WHERE ac.ua_hash='2693f0f6d8498101'
   AND EXISTS (SELECT 1 FROM published_content pc WHERE pc.slug = ac.slug);
-- 4
```

Then the arithmetic. Non-auditor rows matching a published slug: **242**. Auditor rows matching: **4**. And:

```sql
SELECT SUM(clicks) FROM published_content;
-- 246
```

242 + 4 = 246, exactly. The counter is the row count, auditor included.

The code confirms the mechanism rather than leaving it to inference. In the `/go/:slug` handler, both writes sit in the same function:

```js
await env.CRM_DB.prepare('INSERT INTO affiliate_clicks ...').run();
await env.CRM_DB.prepare('UPDATE published_content SET clicks = clicks + 1 WHERE slug = ?')
  .bind(slug).run();
```

Gated only by `if (!probe)`. **No User-Agent check, no bot filter.** Anything that reaches the redirect increments the counter, including my own auditor.

So: **4 of my 246 reported clicks — 1.6% — are my own cron job.** Small enough not to change any decision. Large enough that "it doesn't touch the published counter" was simply wrong, and I'd have shipped it as fact.

## The third wrong thing: it was never scheduled

The obvious question this post raises is why the auditor stopped on 18 August. I assumed the schedule had broken, and went looking for which routine had failed.

None had. **Nothing was ever scheduled to run it.**

I have five automated routines. Not one invokes `npm run audit:live`. The weekly integrity sweep I assumed was running it mentions the auditor three times — all commentary about its blind spots, never a call. The dates confirm it independently: those 308 rows span 8 August, a **Saturday**, to 18 August, a **Tuesday**. The weekly routine fires on Mondays. Neither endpoint is a Monday.

Those were manual runs. Me, typing the command, during a stretch when I happened to be working on the auditor.

There is a CI workflow that runs it weekly as a declared backstop. Its own header comment says the local routine is "the primary path and this workflow is the backstop, not the other way round." The primary path was a sentence in a comment. It was never built.

And the backstop has failed every run — three for three — at a link-check step *after* the audit step succeeds, discarding a good audit before the report is written. So the audit ran, passed, and was thrown away, weekly, into a channel nobody reads.

**The contamination didn't stop because anything was fixed. It stopped because I stopped typing the command.**

## What I was wrong about

**I treated an unexplained pattern as an external event.** The generating process was inside my own repo, under a User-Agent string I chose and forgot.

**I dismissed the correct answer on day one.** Early on I recorded that Node was ruled out by hash comparison. That was real but narrower than I later remembered: I'd ruled out Node's *default* User-Agent. My auditor sets its own. A correct, narrow finding got carried forward as a broad one and eliminated the right family of causes immediately. That's the expensive kind of mistake — not a wrong answer, a right answer with its qualifier stripped off.

**I searched the world before searching my own code.** Hashing public UA corpora is a reasonable technique, and it's what I reached for because the framing in my head was "identify this unknown client." Given that `ua_hash` is a hash of *a string some program had to construct*, the cheaper move was to grep every string constant in my own codebase first. Minutes, not days.

**And I wrote a reassurance I hadn't checked.** The `referred = 0` sentence was the most confident line in the draft and the only one that was fabricated. It survived because it sounded like something I'd verified.

## What I did not change

The auditor's behaviour is correct and I'm keeping it. A constant User-Agent and no Referer is right for a deterministic audit tool — that's what makes its traffic identifiable and reproducible. The problem was never that it announced itself consistently. It's that I didn't know my own announcement.

## What generalises

If you run agents that touch your own instrumented endpoints — auditors, health checks, link validators, warmers, screenshot workers — some fraction of your telemetry is you. You won't notice, because self-generated traffic looks exactly like the traffic you hoped for. It arrives on schedule, hits the right pages, and goes up when you ship more.

Three things that are now how I work:

1. **Grep your own repo for the constant before searching the world for the client.** Any identifier your system records was constructed by some program. Check the ones you wrote first.
2. **Carry the qualifier with the finding.** "Node ruled out" and "Node's default UA ruled out" are different claims. The second is true. The first cost me the investigation.
3. **Never quote a contamination ratio without its window.** 43.6% and 62% describe the same 308 rows.
4. **A check you believe is scheduled, but never verified, is not a check.** Mine ran because I typed it. I found that out only because I asked why it stopped — and the answer was that it had never started.

And the one I learned writing this: **run the query before you publish the reassurance.** The sentence you're least likely to check is the one that says everything is fine.

---

*First in a series of failure autopsies from Sovereign OS — a governed autonomous content system I built and run solo. Each states what I believed, what the instrument showed, and what I was wrong about. None are success stories.*

---
