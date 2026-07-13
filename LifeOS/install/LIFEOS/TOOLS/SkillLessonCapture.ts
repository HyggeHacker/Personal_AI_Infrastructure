#!/usr/bin/env bun
/**
 * ── LIFEOS-PRIVATE (skill-lesson) ── (whole file; see danielmiessler/LifeOS#1450)
 *
 * SkillLessonCapture — the capture arm of the inward-arrow loop.
 *
 * A low-rated turn is an objective-ish signal that SOMETHING a skill did was
 * wrong. This module maps that turn to the originating skill (via the temporal
 * attribution join), and — only when attribution is unambiguous, the lesson is
 * not a duplicate, and the skill is under its weekly cap — enqueues a
 * provenance-stamped `skill-lesson` for human approval. It NEVER writes skill
 * content; it only queues a proposal (MemorySystem.add, Tier C, own queue).
 *
 * Design constraints this file honors (REPORT §4.3 / §4.6, SystemsThinking):
 *   - HIGH confidence only. Exactly one skill in the window, or we do not guess.
 *   - Dedup by skill+signal-hash so an intermittently-failing skill does not
 *     fire a near-identical lesson every run.
 *   - Rate-cap per skill per rolling week so the human gate never floods.
 *   - Suppression is LOGGED, never silent — a suppressed recurrence stays
 *     visible (SystemsThinking intervention, the loop's honesty check).
 *   - Provenance stamps the birth signal; the re-verify trigger IS that signal.
 *     A low-rating has no re-runnable probe, so the lesson can only ever expire
 *     to human review — which propose-only already guarantees.
 *
 * CLI:
 *   bun SkillLessonCapture.ts test
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve as pathResolve, join as pathJoin } from "node:path";
import { homedir } from "node:os";

import {
  attribute,
  loadExecutions,
  parseTs,
  type Execution,
  type AttributionConfidence,
} from "./SkillAttribution";
import { add as memoryAdd } from "./MemorySystem";
import { PENDING_SKILL_LESSONS_PATH, type SkillLessonItem } from "./MemoryTypes";

// ── Paths / defaults ──

const CLAUDE_ROOT = pathResolve(homedir(), ".claude");
const LIFEOS_DIR = pathJoin(CLAUDE_ROOT, "LIFEOS");
export const CAPTURE_LOG_PATH = pathJoin(LIFEOS_DIR, "MEMORY", "OBSERVABILITY", "skill-lesson-capture.jsonl");

export const DEFAULT_CAP_PER_WEEK = 3;
export const DEFAULT_WINDOW_MIN = 15;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LESSON_LEN = 600;

// ── Types ──

export type SuppressReason = "dedup" | "rate-cap";

export type CaptureOutcome =
  | { captured: true; id: string; skill: string; signal_hash: string }
  | {
      captured: false;
      reason: "not-low" | "no-context" | "attribution-none" | "low-confidence" | "dedup" | "rate-cap" | "add-failed";
      detail?: string;
    };

export interface CaptureParams {
  ratingTs: string;
  rating: number;
  sessionId: string;
  /** Candidate lesson text (the failure summary / explicit comment). */
  lessonText: string;
  model?: string;
  windowMin?: number;
  capPerWeek?: number;
  excludeSkills?: Set<string>;
  // Injectable seams for tests — default to the live sources.
  executions?: Execution[];
  queuePath?: string;
  captureLogPath?: string;
  addFn?: (item: SkillLessonItem) => { ok: boolean; detail?: { id?: string }; code?: string };
  now?: number;
}

// ── Pure helpers ──

/**
 * Stable dedup key for a (skill, lesson) pair. Normalizes the text so trivial
 * whitespace/case/punctuation differences collapse to the same hash (an
 * intermittently-failing skill re-firing the "same" lesson dedups), while a
 * genuinely different failure text produces a different hash.
 */
export function signalHashFor(skill: string, text: string): string {
  const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(`${skill}\x00${norm}`).digest("hex").slice(0, 16);
}

function confidenceToNum(c: AttributionConfidence): number {
  switch (c) {
    case "high": return 0.7;
    case "medium": return 0.4;
    case "low": return 0.2;
    case "none": return 0;
  }
}

interface QueueRow {
  skill?: string;
  signal_hash?: string;
  ts?: string;
}

function readQueue(path: string): QueueRow[] {
  if (!existsSync(path)) return [];
  const out: QueueRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as QueueRow); } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Decide whether a fresh (skill, signalHash) may be enqueued given the current
 * queue. Two independent gates: dedup (same hash already present, any status)
 * and rate-cap (skill already at/over cap within the trailing week).
 */
export function shouldCapture(
  skill: string,
  signalHash: string,
  queueRows: QueueRow[],
  opts: { capPerWeek?: number; now?: number } = {},
): { ok: true } | { ok: false; reason: SuppressReason } {
  const cap = opts.capPerWeek ?? DEFAULT_CAP_PER_WEEK;
  const now = opts.now ?? Date.now();

  for (const r of queueRows) {
    if (r.signal_hash === signalHash) return { ok: false, reason: "dedup" };
  }
  let recent = 0;
  for (const r of queueRows) {
    if (r.skill !== skill) continue;
    const t = r.ts ? parseTs(r.ts) : NaN;
    if (!Number.isNaN(t) && now - t < WEEK_MS) recent += 1;
  }
  if (recent >= cap) return { ok: false, reason: "rate-cap" };
  return { ok: true };
}

// ── Observability ──

function logCaptureEvent(path: string, event: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch { /* best-effort */ }
}

// ── Main entry ──

/**
 * Attribute a low-rated turn and, if unambiguous + novel + under cap, enqueue a
 * provenance-stamped skill-lesson. Returns a typed outcome; the caller (the
 * satisfaction hook) does not need to branch on it beyond logging.
 */
export function captureSkillLesson(params: CaptureParams): CaptureOutcome {
  const {
    ratingTs, rating, sessionId, lessonText,
    model, windowMin = DEFAULT_WINDOW_MIN, capPerWeek = DEFAULT_CAP_PER_WEEK,
    excludeSkills,
  } = params;
  const queuePath = params.queuePath ?? PENDING_SKILL_LESSONS_PATH;
  const logPath = params.captureLogPath ?? CAPTURE_LOG_PATH;
  const addFn = params.addFn ?? (memoryAdd as CaptureParams["addFn"])!;
  const now = params.now ?? Date.now();

  if (typeof rating !== "number" || rating >= 5) return { captured: false, reason: "not-low" };
  if (!lessonText || !lessonText.trim()) return { captured: false, reason: "no-context" };

  const executions = params.executions ?? loadExecutions();
  const attribution = attribute({ timestamp: ratingTs, rating, session_id: sessionId }, executions, windowMin, excludeSkills);

  // HIGH confidence only: exactly one skill in the window. Anything less is too
  // ambiguous to pin a lesson on one skill — we surface the miss, never guess.
  if (attribution.confidence !== "high") {
    const reason = attribution.confidence === "none" ? "attribution-none" : "low-confidence";
    return { captured: false, reason };
  }

  const skill = attribution.candidates[0]!.skill;
  const signal = `low-rating:${rating}`;
  const signalHash = signalHashFor(skill, lessonText);

  const gate = shouldCapture(skill, signalHash, readQueue(queuePath), { capPerWeek, now });
  if (!gate.ok) {
    // Suppression is logged, never silent — a suppressed recurrence stays visible.
    logCaptureEvent(logPath, { event: "suppressed", reason: gate.reason, skill, signal_hash: signalHash, signal, rating });
    return { captured: false, reason: gate.reason };
  }

  const item: SkillLessonItem = {
    type: "skill-lesson",
    skill,
    target_section: "Gotchas",
    lesson: lessonText.trim().slice(0, MAX_LESSON_LEN),
    signal,
    signal_hash: signalHash,
    confidence: confidenceToNum(attribution.confidence),
    provenance: { ts: new Date(now).toISOString(), session_id: sessionId, model: model ?? "unknown", signal },
    source_session: sessionId,
  };

  const r = addFn(item);
  if (!r || !r.ok) {
    logCaptureEvent(logPath, { event: "add-failed", skill, signal_hash: signalHash, code: r?.code ?? "unknown" });
    return { captured: false, reason: "add-failed", detail: r?.code };
  }
  const id = r.detail?.id ?? "";
  logCaptureEvent(logPath, { event: "captured", id, skill, signal_hash: signalHash, signal, rating });
  return { captured: true, id, skill, signal_hash: signalHash };
}

// ── CLI / self-test ──

function selfTest(): number {
  console.log("SkillLessonCapture self-test starting…");
  let pass = 0, fail = 0;
  const check = (name: string, ok: boolean, detail?: string) => {
    if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
    else    { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
  };

  // ISC-9: signalHashFor stable + collision-separating
  check("signalHashFor: stable for same input",
    signalHashFor("SkillX", "forgot to check the token scope") === signalHashFor("SkillX", "Forgot to check the TOKEN scope!!"));
  check("signalHashFor: different text → different hash",
    signalHashFor("SkillX", "forgot the token scope") !== signalHashFor("SkillX", "wrong output directory"));
  check("signalHashFor: same text, different skill → different hash",
    signalHashFor("SkillX", "same lesson") !== signalHashFor("SkillY", "same lesson"));

  const nowMs = parseTs("2026-07-10T12:00:00Z");
  const hash = signalHashFor("SkillX", "the lesson");

  // ISC-10: dedup — existing signal_hash suppresses
  check("shouldCapture: dedup on existing signal_hash",
    shouldCapture("SkillX", hash, [{ skill: "SkillX", signal_hash: hash, ts: "2026-07-10T11:00:00Z" }], { now: nowMs }).ok === false);
  check("shouldCapture: novel hash allowed",
    shouldCapture("SkillX", "novelhash", [{ skill: "SkillX", signal_hash: hash, ts: "2026-07-10T11:00:00Z" }], { now: nowMs }).ok === true);

  // ISC-11: rate-cap — skill at/over cap within the week
  const threeThisWeek: QueueRow[] = [
    { skill: "SkillX", signal_hash: "h1", ts: "2026-07-09T12:00:00Z" },
    { skill: "SkillX", signal_hash: "h2", ts: "2026-07-08T12:00:00Z" },
    { skill: "SkillX", signal_hash: "h3", ts: "2026-07-07T12:00:00Z" },
  ];
  check("shouldCapture: rate-cap at 3/week", shouldCapture("SkillX", "newhash", threeThisWeek, { capPerWeek: 3, now: nowMs }).ok === false);
  check("shouldCapture: under cap allowed", shouldCapture("SkillX", "newhash", threeThisWeek.slice(0, 2), { capPerWeek: 3, now: nowMs }).ok === true);
  const oldRows: QueueRow[] = [
    { skill: "SkillX", signal_hash: "h1", ts: "2026-06-01T12:00:00Z" },
    { skill: "SkillX", signal_hash: "h2", ts: "2026-06-02T12:00:00Z" },
    { skill: "SkillX", signal_hash: "h3", ts: "2026-06-03T12:00:00Z" },
  ];
  check("shouldCapture: rows older than a week don't count toward cap",
    shouldCapture("SkillX", "newhash", oldRows, { capPerWeek: 3, now: nowMs }).ok === true);

  // ── captureSkillLesson: end-to-end with injected seams ──
  const execWindow: Execution[] = [{ ts: "2026-07-10T11:59:00Z", skill: "SkillSolo", workflow: "W" }];
  const captured: SkillLessonItem[] = [];
  const addFn = (item: SkillLessonItem) => { captured.push(item); return { ok: true, detail: { id: "test-id" } }; };
  const tmpLog = pathJoin(homedir(), ".claude", "LIFEOS", "MEMORY", "OBSERVABILITY", "skill-lesson-capture.test.jsonl");

  // ISC-12: high confidence (exactly one skill) → captured
  const r1 = captureSkillLesson({
    ratingTs: "2026-07-10T12:00:00Z", rating: 3, sessionId: "s1", lessonText: "forgot to verify command surface",
    executions: execWindow, queuePath: "/nonexistent/queue.jsonl", captureLogPath: tmpLog, addFn, now: nowMs,
  });
  check("captureSkillLesson: high-confidence single skill → captured", r1.captured === true && (r1 as any).skill === "SkillSolo");

  // ISC-13: provenance stamped with the birth signal
  check("captured item carries provenance {ts,session_id,model,signal}",
    captured.length === 1 &&
    !!captured[0].provenance.ts &&
    captured[0].provenance.session_id === "s1" &&
    captured[0].provenance.signal === "low-rating:3" &&
    captured[0].signal === "low-rating:3");

  // ISC-12 negative: ambiguous window (2 skills) → NOT captured
  const twoSkills: Execution[] = [
    { ts: "2026-07-10T11:59:00Z", skill: "SkillA" },
    { ts: "2026-07-10T11:58:00Z", skill: "SkillB" },
  ];
  const r2 = captureSkillLesson({
    ratingTs: "2026-07-10T12:00:00Z", rating: 2, sessionId: "s2", lessonText: "something broke",
    executions: twoSkills, queuePath: "/nonexistent/queue.jsonl", captureLogPath: tmpLog, addFn, now: nowMs,
  });
  check("captureSkillLesson: 2-skill window (medium) → not captured", r2.captured === false && (r2 as any).reason === "low-confidence");

  // rating >= 5 → not-low
  const r3 = captureSkillLesson({
    ratingTs: "2026-07-10T12:00:00Z", rating: 7, sessionId: "s3", lessonText: "x",
    executions: execWindow, addFn, now: nowMs, queuePath: "/nonexistent/queue.jsonl", captureLogPath: tmpLog,
  });
  check("captureSkillLesson: rating>=5 → not-low", r3.captured === false && (r3 as any).reason === "not-low");

  // empty lesson → no-context
  const r4 = captureSkillLesson({
    ratingTs: "2026-07-10T12:00:00Z", rating: 2, sessionId: "s4", lessonText: "   ",
    executions: execWindow, addFn, now: nowMs, queuePath: "/nonexistent/queue.jsonl", captureLogPath: tmpLog,
  });
  check("captureSkillLesson: empty lesson → no-context", r4.captured === false && (r4 as any).reason === "no-context");

  // no skill in window → attribution-none
  const r5 = captureSkillLesson({
    ratingTs: "2026-07-10T12:00:00Z", rating: 2, sessionId: "s5", lessonText: "y",
    executions: [], addFn, now: nowMs, queuePath: "/nonexistent/queue.jsonl", captureLogPath: tmpLog,
  });
  check("captureSkillLesson: empty window → attribution-none", r5.captured === false && (r5 as any).reason === "attribution-none");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail === 0) { console.log("✓ SkillLessonCapture self-test PASSED"); return 0; }
  console.error("✗ SkillLessonCapture self-test FAILED");
  return 1;
}

function main() {
  if (process.argv[2] === "test") process.exit(selfTest());
  console.error("Usage: bun SkillLessonCapture.ts test");
  process.exit(2);
}

if (import.meta.main) main();
