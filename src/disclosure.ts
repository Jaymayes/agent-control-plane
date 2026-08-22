// disclosure.ts — deterministic pre-publication checks.
//
// These run as INVERSE GUARDS: content does not publish unless the required markers are
// present. No model call is involved, which is the whole point — asking a model to include a
// disclosure is a request, checking for it is a control.

export interface DisclosureRules {
  /** Require an advertising/affiliate marker (FTC-style). */
  requireAd?: boolean;
  /** Require an AI-generation marker. */
  requireAiGenerated?: boolean;
  /** Additional required literals, matched case-insensitively. */
  requireLiterals?: string[];
}

export type DisclosureKind = "ad" | "ai_generated" | string;

export interface DisclosureDecision {
  allowed: boolean;
  reason: "ok" | "missing_disclosure" | "empty_content";
  missing: DisclosureKind[];
}

/**
 * Default marker patterns. Deliberately permissive about surrounding punctuation and case,
 * deliberately strict about the marker itself — a check that accepts a paraphrase is not a
 * check. Override per-call if your jurisdiction or platform requires different wording.
 */
const AD_PATTERNS: RegExp[] = [
  /(^|[\s(>#])#ad\b/i,
  /\bpaid\s+partnership\b/i,
  /\baffiliate\s+link/i,
  /\bsponsored\b/i,
];

const AI_PATTERNS: RegExp[] = [
  /(^|[\s(>#])#aigenerated\b/i,
  /(^|[\s(>#])#ai\b/i,
  /\bAI[- ]generated\b/i,
  /\bgenerated\s+(?:with|by)\s+AI\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * Check content against disclosure rules. Returns every missing marker rather than the first,
 * so an operator fixing a draft sees the whole list in one pass.
 */
export function checkDisclosures(
  content: string,
  rules: DisclosureRules = {},
): DisclosureDecision {
  const text = String(content ?? "");
  if (!text.trim()) {
    return { allowed: false, reason: "empty_content", missing: [] };
  }

  const missing: DisclosureKind[] = [];

  if (rules.requireAd && !matchesAny(text, AD_PATTERNS)) missing.push("ad");
  if (rules.requireAiGenerated && !matchesAny(text, AI_PATTERNS)) missing.push("ai_generated");

  for (const literal of rules.requireLiterals ?? []) {
    const needle = String(literal ?? "").trim();
    if (!needle) continue;
    if (!text.toLowerCase().includes(needle.toLowerCase())) missing.push(needle);
  }

  return missing.length > 0
    ? { allowed: false, reason: "missing_disclosure", missing }
    : { allowed: true, reason: "ok", missing: [] };
}
