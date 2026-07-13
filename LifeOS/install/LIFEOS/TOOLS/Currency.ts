#!/usr/bin/env bun
/**
 * Currency.ts — the shared currency mechanism for LifeOS skills.
 *
 * A skill keeps external facts (framework versions, taxonomies, research feeds,
 * prices, threat intel) current by owning its own `sources.json` and its own
 * judgment about what counts as changed. This module owns only the PLUMBING that
 * every such skill would otherwise reinvent: formatting and parsing the version
 * stamp, diffing an observed value against stored freshness state, classifying a
 * change into the autonomous or human-gated landing tier, prepend-and-prune of a
 * rolling digest, the PROPOSED UPDATE block, registry validation, and
 * structural-count parsing.
 *
 * Design rule (from the skill-currency methodology, Council finding): consolidate
 * the plumbing, distribute the judgment. This module NEVER decides what changed or
 * whether a change implies a method edit. It provides the mechanism and takes the
 * skill's judgment as input. It performs no network fetch and reads no wall clock
 * except through an injectable `now` parameter, so its self-test is offline and
 * deterministic.
 *
 * Canonical convention: LIFEOS/DOCUMENTATION/Currency/CurrencySystem.md
 *
 * CLI:
 *   bun Currency.ts test
 *   bun Currency.ts validate <path-to-sources.json>
 *   bun Currency.ts stamp "<value>" <YYYY-MM-DD>
 *   bun Currency.ts parse "<a line containing a stamp>"
 *   bun Currency.ts classify <version|new-content|first-run|none> <impliesMethod:true|false>
 */

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";

// ── The version stamp ────────────────────────────────────────────────────────
// Exact format, kept grep-compatible with FrameworkReference.md / FrameworkAnchoring.md:
//   **Version:** <value> **(as of YYYY-MM-DD)**
const STAMP_RE = /\*\*Version:\*\*\s+(.+?)\s+\*\*\(as of (\d{4}-\d{2}-\d{2})\)\*\*/;

export function formatStamp(value: string, date: string): string {
  return `**Version:** ${value} **(as of ${date})**`;
}

export function parseStamp(line: string): { value: string; date: string } | null {
  const m = line.match(STAMP_RE);
  return m ? { value: m[1], date: m[2] } : null;
}

export function findStamps(text: string): Array<{ value: string; date: string; index: number }> {
  const out: Array<{ value: string; date: string; index: number }> = [];
  const re = new RegExp(STAMP_RE, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ value: m[1], date: m[2], index: m.index });
  }
  return out;
}

/** Replace the FIRST stamp whose current value === matchValue, in place. Others untouched. */
export function updateStampInText(
  text: string,
  matchValue: string,
  newValue: string,
  date: string,
): { text: string; replaced: boolean } {
  let replaced = false;
  const out = text.replace(new RegExp(STAMP_RE, "g"), (full, val: string) => {
    if (!replaced && val === matchValue) {
      replaced = true;
      return formatStamp(newValue, date);
    }
    return full;
  });
  return { text: out, replaced };
}

// ── Content hashing (dedup) ──────────────────────────────────────────────────
export function contentHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// ── Diff observed vs stored state ────────────────────────────────────────────
export interface Observed {
  version?: string;
  hash?: string;
}
export interface PriorRecord {
  current_version?: string;
  last_hash?: string;
}
export type ChangeKind = "first-run" | "version" | "new-content" | "none";
export interface Change {
  changed: boolean;
  kind: ChangeKind;
  prev: string | null;
  next: string | null;
}

/** Mechanism only: compare an already-observed value against the stored record. */
export function diff(observed: Observed, prev: PriorRecord | null | undefined): Change {
  if (!prev) {
    return { changed: true, kind: "first-run", prev: null, next: observed.version ?? observed.hash ?? null };
  }
  if (observed.version !== undefined && prev.current_version !== observed.version) {
    return { changed: true, kind: "version", prev: prev.current_version ?? null, next: observed.version };
  }
  if (observed.hash !== undefined && prev.last_hash !== observed.hash) {
    return { changed: true, kind: "new-content", prev: prev.last_hash ?? null, next: observed.hash };
  }
  return { changed: false, kind: "none", prev: null, next: null };
}

// ── Two-tier landing classifier ──────────────────────────────────────────────
// The autonomous/human-gated split. `impliesMethod` is the SKILL's judgment, an
// input, never inferred here: a fact change lands autonomously, a change that
// touches the method itself is held for human review.
export type LandingTier = "autonomous" | "human-gated" | "skip";

export function classifyChange(change: Pick<Change, "kind">, opts: { impliesMethod: boolean }): LandingTier {
  if (change.kind === "none") return "skip";
  return opts.impliesMethod ? "human-gated" : "autonomous";
}

// ── Autonomous landing: rolling digest ───────────────────────────────────────
export function prependAndPrune(entries: string[], newEntry: string, max: number): string[] {
  return [newEntry, ...entries].slice(0, Math.max(0, max));
}

// ── Human-gated landing: PROPOSED UPDATE block ───────────────────────────────
export function proposedUpdateBlock(args: {
  source: string;
  date: string;
  description: string;
  fromWorkflow?: string;
}): string {
  const from = args.fromWorkflow ?? "CurrencyRefresh";
  return (
    `> **PROPOSED UPDATE (from ${from}, ${args.date}):** ${args.description}\n` +
    `> Source: ${args.source}. This may touch method; review before applying, do not silently edit.`
  );
}

// ── Structural-count anchoring ───────────────────────────────────────────────
// Pin a fast-moving matrix by structural counts, not a floating vendor version tag.
export function parseCounts(s: string): Array<{ count: number; label: string }> {
  const out: Array<{ count: number; label: string }> = [];
  const re = /(\d+)\s+([A-Za-z][A-Za-z-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push({ count: Number(m[1]), label: m[2] });
  }
  return out;
}

// ── Registry set-drift ───────────────────────────────────────────────────────
// Version-tracking catches a value change on a known source. Set-drift catches the
// same silent-surface failure one level up: a source observed but not registered
// (something new appeared) or registered but not observed (something was removed).
export function registrySetDrift(
  registryIds: string[],
  observedIds: string[],
): { added: string[]; removed: string[] } {
  const reg = new Set(registryIds);
  const obs = new Set(observedIds);
  return {
    added: observedIds.filter((id) => !reg.has(id)),
    removed: registryIds.filter((id) => !obs.has(id)),
  };
}

// ── Registry validation (the currency contract, enforced) ────────────────────
export interface RegistryValidation {
  ok: boolean;
  errors: string[];
}
const REQUIRED_FIELDS = ["id", "name", "url", "type", "track", "method", "categories", "why"];
const VALID_TRACKS = ["version", "posts"];

export function validateRegistry(json: unknown): RegistryValidation {
  const errors: string[] = [];
  if (!json || typeof json !== "object") {
    return { ok: false, errors: ["registry root is not an object"] };
  }
  const sources = (json as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) {
    return { ok: false, errors: ["registry is missing a 'sources' array"] };
  }
  const seen = new Set<string>();
  sources.forEach((s: Record<string, unknown>, i: number) => {
    const id = typeof s.id === "string" ? s.id : `#${i}`;
    for (const f of REQUIRED_FIELDS) {
      if (s[f] === undefined) errors.push(`source ${id}: missing required field '${f}'`);
    }
    if (s.track !== undefined && !VALID_TRACKS.includes(s.track as string)) {
      errors.push(`source ${id}: unknown track '${String(s.track)}' (want version|posts)`);
    }
    if (s.track === "version" && s.current_version === undefined) {
      errors.push(`source ${id}: track:version requires a current_version`);
    }
    if (s.categories !== undefined && !Array.isArray(s.categories)) {
      errors.push(`source ${id}: categories must be an array`);
    }
    if (typeof s.id === "string") {
      if (seen.has(s.id)) errors.push(`duplicate source id '${s.id}'`);
      seen.add(s.id);
    }
  });
  return { ok: errors.length === 0, errors };
}

// ── Freshness state I/O ──────────────────────────────────────────────────────
export interface SourceState {
  last_checked: string;
  last_hash?: string;
  last_title?: string;
  current_version?: string;
}
export interface CurrencyState {
  last_check_timestamp: string | null;
  sources: Record<string, SourceState>;
}

/** The single sanctioned clock read: a defaulted parameter, injectable for tests. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function loadState(path: string): CurrencyState {
  if (!existsSync(path)) return { last_check_timestamp: null, sources: {} };
  return JSON.parse(readFileSync(path, "utf8")) as CurrencyState;
}

export function saveState(path: string, state: CurrencyState): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function stampSource(
  state: CurrencyState,
  id: string,
  rec: { version?: string; hash?: string; title?: string },
  now?: Date,
): CurrencyState {
  const ts = nowIso(now);
  const entry: SourceState = { last_checked: ts };
  if (rec.hash !== undefined) entry.last_hash = rec.hash;
  if (rec.title !== undefined) entry.last_title = rec.title;
  if (rec.version !== undefined) entry.current_version = rec.version;
  state.sources[id] = entry;
  state.last_check_timestamp = ts;
  return state;
}

// ── Self-test ────────────────────────────────────────────────────────────────
function runTests(): number {
  let passed = 0;
  let failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.log(`  ✗ ${name}`);
    }
  };

  // ISC-1 formatStamp
  ok("ISC-1: formatStamp exact form", formatStamp("1.0 (12 chapters)", "2026-07-11") === "**Version:** 1.0 (12 chapters) **(as of 2026-07-11)**");

  // ISC-2 parseStamp round-trip + null
  const rt = parseStamp(formatStamp("ASI01-ASI10:2026", "2026-07-11"));
  ok("ISC-2: parseStamp round-trips value", rt?.value === "ASI01-ASI10:2026");
  ok("ISC-2: parseStamp round-trips date", rt?.date === "2026-07-11");
  ok("ISC-2: parseStamp null on non-stamp", parseStamp("just some prose") === null);

  // ISC-3 findStamps multi
  const doc = `## A\n${formatStamp("1.0", "2026-01-01")}\n## B\n${formatStamp("2.0", "2026-02-02")}`;
  const stamps = findStamps(doc);
  ok("ISC-3: findStamps finds both", stamps.length === 2 && stamps[0].value === "1.0" && stamps[1].value === "2.0");

  // ISC-4 updateStampInText in place, others untouched
  const upd = updateStampInText(doc, "1.0", "1.1", "2026-03-03");
  ok("ISC-4: updateStamp replaced target", upd.replaced && upd.text.includes("**Version:** 1.1 **(as of 2026-03-03)**"));
  ok("ISC-4: updateStamp left other stamp", upd.text.includes("**Version:** 2.0 **(as of 2026-02-02)**"));
  ok("ISC-4: updateStamp no-match is false", updateStampInText(doc, "9.9", "x", "2026-03-03").replaced === false);

  // ISC-5 contentHash stable + separates
  ok("ISC-5: hash stable", contentHash("hello") === contentHash("hello"));
  ok("ISC-5: hash separates", contentHash("hello") !== contentHash("hell0"));

  // ISC-6 diff kinds
  ok("ISC-6: diff first-run", diff({ version: "1.0" }, null).kind === "first-run");
  ok("ISC-6: diff version change", diff({ version: "2.0" }, { current_version: "1.0" }).kind === "version");
  ok("ISC-6: diff new-content", diff({ hash: "bbb" }, { current_version: "1.0", last_hash: "aaa" }).kind === "new-content");
  ok("ISC-6: diff none", diff({ version: "1.0" }, { current_version: "1.0" }).kind === "none");

  // ISC-7 classifyChange
  ok("ISC-7: human-gated when method", classifyChange({ kind: "version" }, { impliesMethod: true }) === "human-gated");
  ok("ISC-7: autonomous for fact", classifyChange({ kind: "version" }, { impliesMethod: false }) === "autonomous");
  ok("ISC-7: skip when none", classifyChange({ kind: "none" }, { impliesMethod: true }) === "skip");
  // first-run is 100% of a pilot's first execution: it routes the same two ways a version/new-content change does.
  ok("ISC-7: first-run autonomous by default", classifyChange({ kind: "first-run" }, { impliesMethod: false }) === "autonomous");
  ok("ISC-7: first-run human-gated when method", classifyChange({ kind: "first-run" }, { impliesMethod: true }) === "human-gated");

  // ISC-8 prependAndPrune
  const pruned = prependAndPrune(["b", "c", "d"], "a", 3);
  ok("ISC-8: prepend first + cap + drop oldest", pruned.length === 3 && pruned[0] === "a" && !pruned.includes("d"));

  // ISC-9 proposedUpdateBlock shape
  const block = proposedUpdateBlock({ source: "OWASP ASI", date: "2026-07-11", description: "new ASI11 category" });
  ok("ISC-9: PROPOSED UPDATE shape", block.startsWith("> **PROPOSED UPDATE (from CurrencyRefresh, 2026-07-11):** new ASI11 category"));

  // ISC-10 validateRegistry
  const good = { sources: [{ id: "a", name: "A", url: "u", type: "taxonomy", track: "version", method: "webfetch", current_version: "1.0", categories: ["x"], why: "w" }] };
  ok("ISC-10: valid registry ok", validateRegistry(good).ok);
  const missing = { sources: [{ id: "a", name: "A", url: "u", type: "t", track: "posts", method: "webfetch", categories: ["x"] }] };
  ok("ISC-10: missing 'why' flagged", validateRegistry(missing).errors.some((e) => e.includes("'why'")));
  const badTrack = { sources: [{ id: "a", name: "A", url: "u", type: "t", track: "weekly", method: "webfetch", categories: ["x"], why: "w" }] };
  ok("ISC-10: unknown track flagged", validateRegistry(badTrack).errors.some((e) => e.includes("unknown track")));
  const dup = { sources: [good.sources[0], good.sources[0]] };
  ok("ISC-10: duplicate id flagged", validateRegistry(dup).errors.some((e) => e.includes("duplicate")));

  // ISC-11 stampSource deterministic
  const st: CurrencyState = { last_check_timestamp: null, sources: {} };
  stampSource(st, "atlas", { version: "16/84/56", hash: "h1", title: "ATLAS" }, new Date("2026-07-11T00:00:00Z"));
  ok("ISC-11: stampSource writes record", st.sources.atlas.current_version === "16/84/56" && st.sources.atlas.last_hash === "h1");
  ok("ISC-11: stampSource sets last_check_timestamp", st.last_check_timestamp === "2026-07-11T00:00:00.000Z");

  // ISC-12 parseCounts
  const counts = parseCounts("16 tactics / 84 techniques / 56 sub-techniques / 42 case-studies");
  ok("ISC-12: parseCounts pairs", counts.length === 4 && counts[0].count === 16 && counts[0].label === "tactics" && counts[2].label === "sub-techniques");

  // registrySetDrift
  const sd = registrySetDrift(["a", "b", "c"], ["a", "b", "d"]);
  ok("registrySetDrift: added = observed-not-registered", sd.added.length === 1 && sd.added[0] === "d");
  ok("registrySetDrift: removed = registered-not-observed", sd.removed.length === 1 && sd.removed[0] === "c");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed === 0) console.log("✓ Currency self-test PASSED");
  else console.log("✗ Currency self-test FAILED");
  return failed === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "test":
      process.exit(runTests());
      break;
    case "validate": {
      const path = args[0];
      if (!path) {
        console.error("usage: Currency.ts validate <path-to-sources.json>");
        process.exit(2);
      }
      const json = JSON.parse(readFileSync(path, "utf8"));
      const res = validateRegistry(json);
      if (res.ok) {
        console.log(`OK: ${path} is a valid currency registry (${(json.sources || []).length} sources, 0 errors)`);
        process.exit(0);
      } else {
        console.log(`INVALID: ${path}`);
        for (const e of res.errors) console.log(`  - ${e}`);
        process.exit(1);
      }
      break;
    }
    case "stamp":
      console.log(formatStamp(args[0] ?? "", args[1] ?? ""));
      break;
    case "parse":
      console.log(JSON.stringify(parseStamp(args.join(" ")), null, 2));
      break;
    case "classify":
      console.log(classifyChange({ kind: (args[0] as ChangeKind) ?? "none" }, { impliesMethod: args[1] === "true" }));
      break;
    default:
      console.log("Currency.ts — shared currency mechanism. Commands: test | validate <path> | stamp <value> <date> | parse <line> | classify <kind> <impliesMethod>");
      console.log("Contract: LIFEOS/DOCUMENTATION/Currency/CurrencySystem.md");
  }
}
