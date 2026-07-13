#!/usr/bin/env bun
/**
 * SkillAttribution — map a rated turn to the skill(s) that produced it.
 *
 * The inward-capture loop needs to know which skill a low-rated turn came from,
 * so a lesson can be routed to that skill's own Gotchas. But the two logs do not
 * share a key:
 *
 *   ratings.jsonl    — { timestamp, rating, session_id, ... }   (turn, no skill)
 *   execution.jsonl  — { ts, skill, workflow, ... }             (skill, no session)
 *
 * So attribution is a bounded TEMPORAL join: a rating is captured on the next
 * UserPromptSubmit and refers to the PREVIOUS assistant turn, so the skills that
 * produced that turn are the ones whose execution `ts` falls just before the
 * rating's timestamp. This is a heuristic, not an identity: when several skills
 * ran in the window it cannot say which one earned the rating, so it returns all
 * candidates closest-first and DOWNGRADES its confidence rather than guessing.
 * That ambiguity is surfaced, never hidden.
 *
 * CLI:
 *   bun SkillAttribution.ts test
 *   bun SkillAttribution.ts attribute --ts <iso> [--window-min N] [--json]
 *   bun SkillAttribution.ts low [--threshold N] [--window-min N] [--limit N] [--json]
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve as pathResolve, join as pathJoin } from "node:path";
import { homedir } from "node:os";

// ── Paths ──

const CLAUDE_ROOT = pathResolve(homedir(), ".claude");
const LIFEOS_DIR = pathJoin(CLAUDE_ROOT, "LIFEOS");
export const RATINGS_PATH = pathJoin(LIFEOS_DIR, "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl");
export const EXECUTION_PATH = pathJoin(LIFEOS_DIR, "MEMORY", "SKILLS", "execution.jsonl");

export const DEFAULT_WINDOW_MIN = 15;
export const DEFAULT_LOW_THRESHOLD = 3;

// ── Types ──

export interface Rating {
  timestamp: string;
  rating: number;
  session_id?: string;
  source?: string;
  sentiment_summary?: string;
}

export interface Execution {
  ts: string;
  skill: string;
  workflow?: string;
  status?: string;
}

export type AttributionConfidence = "high" | "medium" | "low" | "none";

export interface AttributedSkill {
  skill: string;
  workflow: string | null;
  ts: string;
  lag_seconds: number; // rating_ts - execution_ts, in seconds (>= 0)
}

export interface Attribution {
  rating_ts: string;
  rating: number | null;
  session_id: string | null;
  window_min: number;
  candidates: AttributedSkill[];
  confidence: AttributionConfidence;
}

// ── Time ──

/**
 * Parse an ISO-8601 timestamp to epoch milliseconds. Handles both the
 * TZ-offset form used by ratings.jsonl (`2026-07-06T01:26:51-04:00`) and the
 * Z form used by execution.jsonl (`2026-07-09T04:14:09Z`) — both are valid
 * Date inputs and normalize to the same absolute instant. Returns NaN on junk.
 */
export function parseTs(s: string): number {
  if (!s || typeof s !== "string") return NaN;
  return new Date(s).getTime();
}

// ── Core (pure — takes arrays, no I/O) ──

/**
 * Score attribution confidence from the number of candidate skills in the
 * window. One skill in the window is an unambiguous attribution; several means
 * we cannot tell which earned the rating, so confidence drops with count.
 */
export function scoreConfidence(candidateCount: number): AttributionConfidence {
  if (candidateCount === 0) return "none";
  if (candidateCount === 1) return "high";
  if (candidateCount <= 3) return "medium";
  return "low";
}

/**
 * Attribute one rating timestamp to the skills that ran in the window before it.
 * Executions are kept when their `ts` lies in `[ratingTs - window, ratingTs]`,
 * i.e. at or before the rating and no older than the window. Anything AFTER the
 * rating, or older than the window, is excluded. Result is closest-first.
 *
 * Two known biases the caller must keep in mind, neither fully cured here:
 *   - Closest-first favours skills that habitually run LAST in a turn (telemetry,
 *     formatters, capture writers). Pass `excludeSkills` to drop such always-last
 *     skills so they do not dominate attribution. This returns ALL in-window
 *     candidates, not a single winner, so downstream can weight rather than trust
 *     the top row.
 *   - execution.jsonl carries no session_id, so a concurrent session's skills can
 *     land in the same wall-clock window. The confidence downgrade surfaces the
 *     resulting ambiguity but cannot distinguish "multi-skill pipeline" from
 *     "unrelated concurrent session". The real fix is a session_id on execution.jsonl.
 */
export function attributeOne(
  ratingTsMs: number,
  executions: Execution[],
  windowMs: number,
  excludeSkills?: Set<string>,
): AttributedSkill[] {
  const lo = ratingTsMs - windowMs;
  const hits: AttributedSkill[] = [];
  for (const e of executions) {
    if (excludeSkills?.has(e.skill)) continue; // always-last / telemetry skills
    const t = parseTs(e.ts);
    if (Number.isNaN(t)) continue;
    if (t < lo || t > ratingTsMs) continue; // outside window, or after the rating
    hits.push({
      skill: e.skill,
      workflow: e.workflow ?? null,
      ts: e.ts,
      lag_seconds: Math.round((ratingTsMs - t) / 1000),
    });
  }
  // closest to the rating first (smallest lag)
  hits.sort((a, b) => a.lag_seconds - b.lag_seconds);
  return hits;
}

export function attribute(
  rating: Rating,
  executions: Execution[],
  windowMin: number = DEFAULT_WINDOW_MIN,
  excludeSkills?: Set<string>,
): Attribution {
  const windowMs = windowMin * 60 * 1000;
  const ratingTsMs = parseTs(rating.timestamp);
  const candidates = Number.isNaN(ratingTsMs) ? [] : attributeOne(ratingTsMs, executions, windowMs, excludeSkills);
  return {
    rating_ts: rating.timestamp,
    rating: typeof rating.rating === "number" ? rating.rating : null,
    session_id: rating.session_id ?? null,
    window_min: windowMin,
    candidates,
    confidence: scoreConfidence(candidates.length),
  };
}

/**
 * Attribute every low rating (rating <= threshold) to its producing skill(s).
 * Newest first, capped at `limit`.
 */
export function attributeLowRatings(
  ratings: Rating[],
  executions: Execution[],
  opts: { threshold?: number; windowMin?: number; limit?: number; excludeSkills?: Set<string> } = {},
): Attribution[] {
  const threshold = opts.threshold ?? DEFAULT_LOW_THRESHOLD;
  const windowMin = opts.windowMin ?? DEFAULT_WINDOW_MIN;
  const limit = opts.limit ?? 50;
  return ratings
    .filter((r) => typeof r.rating === "number" && r.rating <= threshold)
    .sort((a, b) => parseTs(b.timestamp) - parseTs(a.timestamp))
    .slice(0, limit)
    .map((r) => attribute(r, executions, windowMin, opts.excludeSkills));
}

// ── I/O ──

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as T); } catch { /* skip malformed line */ }
  }
  return out;
}

export function loadRatings(path: string = RATINGS_PATH): Rating[] {
  return readJsonl<Rating>(path);
}

export function loadExecutions(path: string = EXECUTION_PATH): Execution[] {
  return readJsonl<Execution>(path);
}

// ── CLI ──

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function selfTest(): number {
  console.log("SkillAttribution self-test starting…");
  let pass = 0, fail = 0;
  const check = (name: string, ok: boolean, detail?: string) => {
    if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
    else    { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
  };

  // ISC-9: both timestamp forms parse to the same instant
  check(
    "parseTs: TZ-offset and Z forms equal for the same instant",
    parseTs("2026-07-09T08:00:00-04:00") === parseTs("2026-07-09T12:00:00Z"),
    `${parseTs("2026-07-09T08:00:00-04:00")} vs ${parseTs("2026-07-09T12:00:00Z")}`,
  );

  const ratingTs = "2026-07-09T12:00:00Z";
  const execs: Execution[] = [
    { ts: "2026-07-09T11:59:00Z", skill: "skillA", workflow: "wA" }, //   60s before → in
    { ts: "2026-07-09T11:50:00Z", skill: "skillB", workflow: "wB" }, //  600s before → in
    { ts: "2026-07-09T11:40:00Z", skill: "skillC", workflow: "wC" }, // 1200s before → out (>15m)
    { ts: "2026-07-09T12:01:00Z", skill: "skillD", workflow: "wD" }, //   60s AFTER   → out
  ];

  const r = attribute({ timestamp: ratingTs, rating: 2, session_id: "s1" }, execs, 15);

  // ISC-7: closest-first ordering
  check("attributes A then B (closest-first)",
    r.candidates.map((c) => c.skill).join(",") === "skillA,skillB",
    r.candidates.map((c) => c.skill).join(","));
  // ISC-8: excludes after-the-rating and outside-window
  check("excludes skillC (outside window)", !r.candidates.some((c) => c.skill === "skillC"));
  check("excludes skillD (after the rating)", !r.candidates.some((c) => c.skill === "skillD"));
  check("lag_seconds for A is 60", r.candidates[0]?.lag_seconds === 60, String(r.candidates[0]?.lag_seconds));

  // ISC-11: confidence downgrades with candidate count
  check("2 candidates → medium confidence", r.confidence === "medium", r.confidence);
  const one = attribute({ timestamp: ratingTs, rating: 2 }, [execs[0]], 15);
  check("1 candidate → high confidence", one.confidence === "high", one.confidence);
  const many = attribute({ timestamp: ratingTs, rating: 2 }, [
    { ts: "2026-07-09T11:59:00Z", skill: "s1" },
    { ts: "2026-07-09T11:58:00Z", skill: "s2" },
    { ts: "2026-07-09T11:57:00Z", skill: "s3" },
    { ts: "2026-07-09T11:56:00Z", skill: "s4" },
  ], 15);
  check("4 candidates → low confidence", many.confidence === "low", many.confidence);
  check("0 candidates → none confidence",
    attribute({ timestamp: ratingTs, rating: 2 }, [], 15).confidence === "none");

  // excludeSkills drops always-last / telemetry skills so they don't dominate
  const excl = attribute({ timestamp: ratingTs, rating: 2 }, execs, 15, new Set(["skillA"]));
  check("excludeSkills drops skillA, keeps skillB",
    excl.candidates.map((c) => c.skill).join(",") === "skillB",
    excl.candidates.map((c) => c.skill).join(","));

  // ISC-9 (join): a Z execution correctly matches an offset-form rating
  const rOffset = attribute({ timestamp: "2026-07-09T08:00:00-04:00", rating: 2 }, [execs[0]], 15);
  check("offset-form rating matches Z-form execution", rOffset.candidates.length === 1 && rOffset.candidates[0].skill === "skillA");

  // ISC-10: low-mode filters by threshold
  const ratings: Rating[] = [
    { timestamp: "2026-07-09T12:00:00Z", rating: 5 },
    { timestamp: "2026-07-09T12:05:00Z", rating: 3 },
    { timestamp: "2026-07-09T12:10:00Z", rating: 2 },
  ];
  const low = attributeLowRatings(ratings, execs, { threshold: 3, windowMin: 15 });
  check("low-mode selects only rating<=3 (2 of 3)", low.length === 2, `got ${low.length}`);
  check("low-mode newest-first", low[0].rating === 2 && low[1].rating === 3);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail === 0) { console.log("✓ SkillAttribution self-test PASSED"); return 0; }
  console.error("✗ SkillAttribution self-test FAILED");
  return 1;
}

function main() {
  const cmd = process.argv[2];

  if (cmd === "test") process.exit(selfTest());

  if (cmd === "attribute") {
    const ts = getFlag("ts");
    if (!ts) { console.error("Usage: bun SkillAttribution.ts attribute --ts <iso> [--window-min N]"); process.exit(2); }
    const windowMin = Number(getFlag("window-min") ?? DEFAULT_WINDOW_MIN);
    const result = attribute({ timestamp: ts, rating: NaN as any }, loadExecutions(), windowMin);
    if (hasFlag("json")) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
    console.log(`Rating @ ${result.rating_ts} — confidence: ${result.confidence}`);
    for (const c of result.candidates) console.log(`  ${c.skill}${c.workflow ? `/${c.workflow}` : ""}  (${c.lag_seconds}s before)`);
    if (result.candidates.length === 0) console.log("  (no skill executions in window)");
    process.exit(0);
  }

  if (cmd === "low") {
    const threshold = Number(getFlag("threshold") ?? DEFAULT_LOW_THRESHOLD);
    const windowMin = Number(getFlag("window-min") ?? DEFAULT_WINDOW_MIN);
    const limit = Number(getFlag("limit") ?? 20);
    const results = attributeLowRatings(loadRatings(), loadExecutions(), { threshold, windowMin, limit });
    if (hasFlag("json")) { console.log(JSON.stringify(results, null, 2)); process.exit(0); }
    console.log(`${results.length} low ratings (<=${threshold}), window ${windowMin}m:\n`);
    for (const a of results) {
      const skills = a.candidates.length ? a.candidates.map((c) => c.skill).join(", ") : "(none in window)";
      console.log(`  ${a.rating_ts}  rating=${a.rating}  [${a.confidence}]  → ${skills}`);
    }
    process.exit(0);
  }

  console.error("Usage: bun SkillAttribution.ts {test | attribute --ts <iso> | low [--threshold N]}");
  process.exit(2);
}

if (import.meta.main) main();
