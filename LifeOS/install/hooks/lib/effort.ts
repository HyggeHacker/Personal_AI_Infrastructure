/**
 * Legacy effort-tier normalizer (historical data only).
 *
 * Effort tiers (E1-E5 / Standard..Comprehensive) were retired 2026-07-11 when
 * judgment-based spend replaced fixed tiers. Nothing routes on these values
 * anymore. This normalizer survives ONLY so historical rows keep a stable
 * display label: archived work.json sessions and ISA frontmatter written before
 * the retirement still carry an `effort` value, and live Pulse consumers render
 * those historical rows.
 *
 * Do NOT add new writers of the `effort` field, and do NOT reintroduce
 * tier-based routing. Every shape below is historical:
 * - Legacy ISA frontmatter: `effort: E3`
 * - Legacy lowercase / title-cased tier names: `effort: advanced` / `Advanced`
 * - Native / blank sessions: `effort: native` or `effort: ''`
 * - Anything else: empty / undefined / garbage
 */

export type EffortELevel = 'E1' | 'E2' | 'E3' | 'E4' | 'E5';
export type EffortTierName = 'Standard' | 'Extended' | 'Advanced' | 'Deep' | 'Comprehensive';

export interface NormalizedEffort {
  eLevel: EffortELevel;
  tierName: EffortTierName;
}

const TIER_BY_E: Record<EffortELevel, EffortTierName> = {
  E1: 'Standard',
  E2: 'Extended',
  E3: 'Advanced',
  E4: 'Deep',
  E5: 'Comprehensive',
};

const E_BY_TIER: Record<string, EffortELevel> = {
  standard: 'E1',
  extended: 'E2',
  advanced: 'E3',
  deep: 'E4',
  comprehensive: 'E5',
};

/**
 * Parse any effort encoding into the canonical { eLevel, tierName } pair, or
 * return null when the input doesn't represent a real effort tier (native,
 * starting, empty, garbage).
 */
export function normalizeEffort(input: unknown): NormalizedEffort | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const eMatch = trimmed.match(/^[Ee]([1-5])$/);
  if (eMatch) {
    const eLevel = `E${eMatch[1]}` as EffortELevel;
    return { eLevel, tierName: TIER_BY_E[eLevel] };
  }

  const lower = trimmed.toLowerCase();
  if (lower in E_BY_TIER) {
    const eLevel = E_BY_TIER[lower];
    return { eLevel, tierName: TIER_BY_E[eLevel] };
  }

  return null;
}

/** Canonical write form for work.json `effort` field. Empty string when no tier applies. */
export function effortToCanonicalELevel(input: unknown): '' | EffortELevel {
  const n = normalizeEffort(input);
  return n ? n.eLevel : '';
}

/** Canonical render form for the API boundary `effortLevel` field. Empty string when no tier applies. */
export function effortToCanonicalTierName(input: unknown): '' | EffortTierName {
  const n = normalizeEffort(input);
  return n ? n.tierName : '';
}
