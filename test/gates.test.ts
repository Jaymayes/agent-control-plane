import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HARD_CAP_USD,
  estimateCostUsd,
  evaluateBudget,
  evaluateBudgetOnStoreError,
} from "../src/budget-gate.ts";
import { evaluateRelease, evaluateRetraction } from "../src/approval-gate.ts";
import { checkDisclosures } from "../src/disclosure.ts";

// ── budget gate ─────────────────────────────────────────────────────────────

test("allows spend below the cap", () => {
  const d = evaluateBudget({ spentUsd: 0.1, capUsd: 0.32 });
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "ok");
});

test("blocks at exactly the cap, not just above it", () => {
  const d = evaluateBudget({ spentUsd: 0.32, capUsd: 0.32 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "cap_exceeded");
});

test("sticky kill switch blocks even when spend is under the cap", () => {
  const d = evaluateBudget({ spentUsd: 0, capUsd: 0.32, killSwitchHit: true });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "kill_switch");
});

test("a zero or missing cap falls back to the default, never to unlimited", () => {
  for (const capUsd of [0, -1, Number.NaN, undefined as unknown as number]) {
    const d = evaluateBudget({ spentUsd: DEFAULT_HARD_CAP_USD, capUsd });
    assert.equal(d.capUsd, DEFAULT_HARD_CAP_USD);
    assert.equal(d.allowed, false, `cap ${String(capUsd)} must not read as unlimited`);
  }
});

test("negative spend is clamped to zero rather than buying headroom", () => {
  const d = evaluateBudget({ spentUsd: -100, capUsd: 1 });
  assert.equal(d.spentUsd, 0);
  assert.equal(d.allowed, true);
});

test("store-error posture defaults to blocking and opts into allowing", () => {
  assert.equal(evaluateBudgetOnStoreError(1).allowed, false);
  assert.equal(evaluateBudgetOnStoreError(1, { onStoreError: "block" }).allowed, false);
  assert.equal(evaluateBudgetOnStoreError(1, { onStoreError: "allow" }).allowed, true);
  assert.equal(evaluateBudgetOnStoreError(1).reason, "store_unavailable");
});

test("unknown models are priced conservatively, not treated as free", () => {
  assert.ok(estimateCostUsd("some-model-nobody-listed", 1000) > 0);
});

test("zero-cost models accrue nothing", () => {
  assert.equal(estimateCostUsd("@cf/meta/llama-3.1-8b-instruct", 1_000_000), 0);
});

test("zero tokens costs nothing regardless of model", () => {
  assert.equal(estimateCostUsd("gemini-2.5-flash", 0), 0);
});

// ── approval gate ───────────────────────────────────────────────────────────

test("pending content without a releaser is blocked", () => {
  const d = evaluateRelease({ status: "pending", releasedBy: null });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "awaiting_human_release");
});

test("whitespace is not a human release", () => {
  assert.equal(evaluateRelease({ status: "pending", releasedBy: "   " }).allowed, false);
});

test("an explicit human release permits publication", () => {
  const d = evaluateRelease({ status: "pending", releasedBy: "operator@example.com" });
  assert.equal(d.allowed, true);
});

test("rejected and retracted items cannot be published by re-releasing", () => {
  for (const status of ["rejected", "retracted"] as const) {
    const d = evaluateRelease({ status, releasedBy: "operator@example.com" });
    assert.equal(d.allowed, false, `${status} must not be publishable`);
  }
});

test("retraction is always permitted for live content", () => {
  assert.equal(evaluateRetraction({ status: "released" }).allowed, true);
  assert.equal(evaluateRetraction({ status: "pending" }).allowed, true);
  assert.equal(evaluateRetraction({ status: "retracted" }).allowed, false);
});

// ── disclosure guard ────────────────────────────────────────────────────────

test("missing disclosures are all reported, not just the first", () => {
  const d = checkDisclosures("A review with no markers at all.", {
    requireAd: true,
    requireAiGenerated: true,
  });
  assert.equal(d.allowed, false);
  assert.deepEqual(d.missing.sort(), ["ad", "ai_generated"]);
});

test("present disclosures pass", () => {
  const d = checkDisclosures("Honest review. #ad #AIGenerated", {
    requireAd: true,
    requireAiGenerated: true,
  });
  assert.equal(d.allowed, true);
  assert.deepEqual(d.missing, []);
});

test("a hashtag inside a word does not count as a disclosure", () => {
  const d = checkDisclosures("Read about the broadcast#advertising model.", { requireAd: true });
  assert.equal(d.allowed, false);
});

test("empty content is blocked rather than silently passing", () => {
  const d = checkDisclosures("   ", { requireAd: true });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "empty_content");
});

test("required literals are matched case-insensitively", () => {
  const rules = { requireLiterals: ["Results may vary"] };
  assert.equal(checkDisclosures("results MAY vary here", rules).allowed, true);
  assert.equal(checkDisclosures("no such text", rules).allowed, false);
});

test("no rules means nothing to enforce", () => {
  assert.equal(checkDisclosures("anything").allowed, true);
});
