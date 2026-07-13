#!/usr/bin/env bun
/**
 * PatternCurrency.ts — currency for the Fabric skill's pattern corpus.
 *
 * The second currency repoint, on a different update class than Recon. Recon
 * tracked a fixed list of tool versions (class B). Fabric tracks a dynamic corpus
 * of ~237 pattern directories synced from upstream (class C). The tracked "registry"
 * is the live corpus discovered from disk, not a static file, so this driver reuses
 * the helper's state, set-drift, stamp, and hashing plumbing but not its static
 * registry validation. The landing (the rsync) and the delete-guard judgment stay
 * the skill's own.
 *
 * Why it exists: the old UpdatePatterns blind-mirrored upstream over local with
 * `rsync -av --delete`, silently wiping any local-only pattern, verified by a file
 * count that cannot catch a same-count swap. This driver previews the set difference
 * first, so the patterns `--delete` would destroy are surfaced before anything runs.
 *
 * Import note: skills are symlinked from their source repo, so the shared helper is
 * imported by a configured anchor (CLAUDE_CONFIG_DIR or ~/.claude), not a relative path.
 *
 * Contract: LIFEOS/DOCUMENTATION/Currency/CurrencySystem.md
 *
 * CLI:
 *   bun PatternCurrency.ts preview   # read-only: show gained + would-delete vs upstream
 *   bun PatternCurrency.ts stamp     # record the synced pattern set after an explicit sync
 *   bun PatternCurrency.ts status    # print stamped state
 *   bun PatternCurrency.ts test      # deterministic self-test (no fabric needed)
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";

// ── Shared helper, imported by configured anchor (skills are symlinked) ───────
type CurrencyState = {
  last_check_timestamp: string | null;
  sources: Record<string, { last_checked: string; last_hash?: string; last_title?: string; current_version?: string }>;
};
interface CurrencyHelper {
  loadState(path: string): CurrencyState;
  saveState(path: string, state: CurrencyState): void;
  stampSource(state: CurrencyState, id: string, rec: { version?: string; hash?: string; title?: string }, now?: Date): CurrencyState;
  registrySetDrift(registryIds: string[], observedIds: string[]): { added: string[]; removed: string[] };
  contentHash(s: string): string;
}
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const CURRENCY = join(CLAUDE_DIR, "LIFEOS", "TOOLS", "Currency.ts");
const helper = (await import(CURRENCY)) as CurrencyHelper;
for (const k of ["loadState", "saveState", "stampSource", "registrySetDrift", "contentHash"] as const) {
  if (typeof (helper as Record<string, unknown>)[k] !== "function") {
    throw new Error(`currency helper: ${k} missing or not a function — Currency.ts API drifted`);
  }
}
const { loadState, saveState, stampSource, registrySetDrift, contentHash } = helper;

const HERE = dirname(new URL(import.meta.url).pathname);
const LOCAL_PATTERNS = join(HERE, "..", "Patterns");
const UPSTREAM_PATTERNS = join(homedir(), ".config", "fabric", "patterns");
const STATE = join(HERE, "..", "State", "currency-state.json");
const CORPUS_ID = "fabric-patterns";

// ── Skill-owned observation: list pattern directories ─────────────────────────
export function listPatternDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
export function observeLocal(): string[] {
  return listPatternDirs(LOCAL_PATTERNS);
}
export function observeUpstream(): string[] {
  return listPatternDirs(UPSTREAM_PATTERNS);
}

/** Order-independent hash of a pattern set, so a reorder is not a false change. */
export function patternSetHash(names: string[]): string {
  return contentHash([...names].sort().join(","));
}

// ── The preview: what a sync would gain and what --delete would destroy ───────
// NEVER mutates. gained = upstream-not-local (safe to add); wouldDelete = local-not-upstream
// (the local-only patterns a blind `rsync --delete` would wipe).
export function preview(local: string[], upstream: string[]): { gained: string[]; wouldDelete: string[] } {
  const sd = registrySetDrift(local, upstream);
  return { gained: sd.added, wouldDelete: sd.removed };
}

// ── The mechanical delete-guard ───────────────────────────────────────────────
// A prose "review the deletions" instruction is theater; this is the enforced rule.
// The `guard` CLI exits non-zero when local-only patterns would be destroyed, so the
// workflow's `guard && rsync --delete` cannot blind-delete. --allow-delete is the
// explicit override, an acknowledgement, not a bypass.
export function guardDecision(wouldDelete: string[], allowDelete: boolean): { ok: boolean; reason: string } {
  if (wouldDelete.length === 0) return { ok: true, reason: "no local-only patterns; safe to sync" };
  if (allowDelete) return { ok: true, reason: `override: ${wouldDelete.length} local-only pattern(s) acknowledged for deletion` };
  return { ok: false, reason: `${wouldDelete.length} local-only pattern(s) would be deleted; back them up or pass --allow-delete` };
}

// ── Stamp: record the synced pattern set after an explicit sync. Mutates state. ─
export function stamp(state: CurrencyState, upstream: string[], now?: Date): CurrencyState {
  return stampSource(state, CORPUS_ID, { version: patternSetHash(upstream), title: `${upstream.length} patterns` }, now);
}

// ── Self-test (deterministic, no fabric) ──────────────────────────────────────
function runTests(): number {
  let passed = 0;
  let failed = 0;
  const ok = (name: string, cond: boolean) => {
    cond ? passed++ : failed++;
    console.log(`  ${cond ? "✓" : "✗"} ${name}`);
  };

  const local = ["a", "b", "c", "custom_local"];
  const upstream = ["a", "b", "c", "d"];

  const p = preview(local, upstream);
  ok("ISC-3: gained = upstream-not-local", p.gained.length === 1 && p.gained[0] === "d");
  ok("ISC-5: wouldDelete = the local-only pattern", p.wouldDelete.length === 1 && p.wouldDelete[0] === "custom_local");

  ok("ISC-8: set hash is order-independent", patternSetHash(["b", "a", "c"]) === patternSetHash(["c", "a", "b"]));

  const state: CurrencyState = { last_check_timestamp: null, sources: {} };
  stamp(state, upstream, new Date("2026-07-12T00:00:00Z"));
  ok("ISC-6: stamp records set hash", state.sources[CORPUS_ID]?.current_version === patternSetHash(upstream));
  ok("ISC-6: stamp records count", state.sources[CORPUS_ID]?.last_title === "4 patterns");
  ok("ISC-6: stamp sets timestamp", state.last_check_timestamp === "2026-07-12T00:00:00.000Z");

  const p2 = preview(upstream, upstream);
  ok("ISC-7: synced state has no wouldDelete and no gained", p2.wouldDelete.length === 0 && p2.gained.length === 0);

  // Signature failure mode: equal count with a simultaneous add and remove, which a
  // file-count check cannot see. This is the literal reason the skill was rebuilt.
  const swapLocal = ["A", "B", "C"];
  const swapUp = ["A", "B", "D"];
  const swap = preview(swapLocal, swapUp);
  ok("same-count swap: equal count but a real add and remove", swapLocal.length === swapUp.length && swap.gained.length === 1 && swap.gained[0] === "D" && swap.wouldDelete.length === 1 && swap.wouldDelete[0] === "C");

  // The mechanical guard decision.
  ok("guard blocks a deletion with no override", guardDecision(["custom_local"], false).ok === false);
  ok("guard allows a deletion with --allow-delete", guardDecision(["custom_local"], true).ok === true);
  ok("guard allows when nothing would be deleted", guardDecision([], false).ok === true);

  // Disk discovery (the only new code, which injected sets bypass): real temp dirs.
  const tmp = mkdtempSync(join(tmpdir(), "fabc-"));
  mkdirSync(join(tmp, "p_two"));
  mkdirSync(join(tmp, "p_one"));
  writeFileSync(join(tmp, "loose_file.md"), "not a pattern dir");
  const discovered = listPatternDirs(tmp);
  ok("disk discovery lists dirs only, sorted, files excluded", discovered.length === 2 && discovered[0] === "p_one" && discovered[1] === "p_two");
  rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed === 0 ? "✓ PatternCurrency self-test PASSED" : "✗ PatternCurrency self-test FAILED");
  return failed === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const cmd = process.argv[2];
  switch (cmd) {
    case "test":
      process.exit(runTests());
      break;
    case "preview": {
      const local = observeLocal();
      const upstream = observeUpstream();
      if (upstream.length === 0) {
        console.log(`Upstream not synced (${UPSTREAM_PATTERNS} is empty or absent). Run 'fabric -U' first. Preview is read-only; nothing changed.`);
        break;
      }
      const p = preview(local, upstream);
      console.log(`Local: ${local.length} patterns. Upstream: ${upstream.length} patterns.`);
      if (p.gained.length) console.log(`Would GAIN ${p.gained.length}: ${p.gained.join(", ")}`);
      if (p.wouldDelete.length) {
        console.log(`Would DELETE ${p.wouldDelete.length} local-only pattern(s): ${p.wouldDelete.join(", ")}`);
        console.log("These are NOT in upstream. A blind 'rsync --delete' would destroy them. Review and back up before syncing.");
      }
      if (!p.gained.length && !p.wouldDelete.length) console.log("In sync with upstream. No changes.");
      console.log("Preview only. Nothing was changed.");
      break;
    }
    case "guard": {
      const upstream = observeUpstream();
      if (upstream.length === 0) {
        console.log(`Upstream not synced (${UPSTREAM_PATTERNS}); cannot guard. Run 'fabric -U' first.`);
        process.exit(2);
      }
      const { wouldDelete } = preview(observeLocal(), upstream);
      const decision = guardDecision(wouldDelete, process.argv.includes("--allow-delete"));
      console.log(decision.reason);
      if (wouldDelete.length) console.log(`  would delete: ${wouldDelete.join(", ")}`);
      process.exit(decision.ok ? 0 : 1);
      break;
    }
    case "stamp": {
      const state = loadState(STATE);
      const upstream = observeUpstream();
      const set = upstream.length ? upstream : observeLocal(); // after a sync, local mirrors upstream
      if (set.length === 0) {
        console.log("No pattern set observed — nothing to stamp.");
        break;
      }
      stamp(state, set);
      saveState(STATE, state);
      console.log(`Stamped the synced pattern set (${set.length} patterns) into ${STATE}.`);
      break;
    }
    case "status": {
      const state = loadState(STATE);
      const rec = state.sources[CORPUS_ID];
      console.log(`last check: ${state.last_check_timestamp ?? "never"}`);
      if (rec) console.log(`  ${CORPUS_ID}: ${rec.last_title ?? "?"} (hash ${rec.current_version}, stamped ${rec.last_checked})`);
      break;
    }
    default:
      console.log("PatternCurrency.ts — Fabric pattern-corpus currency. Commands: preview | stamp | status | test");
      console.log("Contract: LIFEOS/DOCUMENTATION/Currency/CurrencySystem.md");
  }
}
