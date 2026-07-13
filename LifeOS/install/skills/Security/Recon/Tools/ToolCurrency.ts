#!/usr/bin/env bun
/**
 * ToolCurrency.ts — currency for the Recon skill's Project Discovery toolchain.
 *
 * This is the thin, skill-owned driver on top of the shared currency helper. Per
 * the currency contract, the helper owns the plumbing (diff, classify, stamp,
 * state) and the skill owns only two things: the fetch (observing installed
 * versions from pdtm) and the judgment (staleness, and whether a jump implies a
 * command-surface change). It reinvents none of the mechanism.
 *
 * Import note: skills are symlinked from their source repo, so a relative import
 * cannot reach ~/.claude/LIFEOS/TOOLS. The shared helper is imported by its
 * canonical home path resolved through homedir(). This is the LifeOS idiom for a
 * skill Tool that calls a core tool across the symlink boundary.
 *
 * Reproducibility contract (from _AZURE_PENTEST tool freshness):
 *   - `check` and the stale warning NEVER mutate. They report drift, nothing else.
 *   - Upgrades are explicit-only and never mid-engagement, run by the operator.
 *   - `stamp` records the exact versions in use so an engagement is reproducible.
 *
 * Contract: LIFEOS/DOCUMENTATION/Currency/CurrencySystem.md
 *
 * CLI:
 *   bun ToolCurrency.ts check    # read-only: warn on drift vs stamped state
 *   bun ToolCurrency.ts stamp    # record installed versions after an explicit update
 *   bun ToolCurrency.ts status   # print stamped state
 *   bun ToolCurrency.ts test     # deterministic self-test (no pdtm needed)
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ── Shared helper, imported by canonical home path (skills are symlinked) ─────
type CurrencyState = {
  last_check_timestamp: string | null;
  sources: Record<string, { last_checked: string; last_hash?: string; last_title?: string; current_version?: string }>;
};
interface CurrencyHelper {
  diff(observed: { version?: string; hash?: string }, prev: unknown): { changed: boolean; kind: string; prev: string | null; next: string | null };
  classifyChange(change: { kind: string }, opts: { impliesMethod: boolean }): string;
  loadState(path: string): CurrencyState;
  saveState(path: string, state: CurrencyState): void;
  stampSource(state: CurrencyState, id: string, rec: { version?: string; hash?: string; title?: string }, now?: Date): CurrencyState;
  registrySetDrift(registryIds: string[], observedIds: string[]): { added: string[]; removed: string[] };
}
// Anchor prefers a configured CLAUDE_CONFIG_DIR and falls back to ~/.claude; a
// relative import cannot reach here because this file is symlinked from its repo.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const CURRENCY = join(CLAUDE_DIR, "LIFEOS", "TOOLS", "Currency.ts");
const helper = (await import(CURRENCY)) as CurrencyHelper;
// Dynamic import trades compile-time checking for runtime resolution, so assert
// the API is present and fail loudly rather than cryptically if Currency.ts drifted.
for (const k of ["diff", "classifyChange", "loadState", "saveState", "stampSource", "registrySetDrift"] as const) {
  if (typeof (helper as Record<string, unknown>)[k] !== "function") {
    throw new Error(`currency helper: ${k} missing or not a function — Currency.ts API drifted`);
  }
}
const { diff, classifyChange, loadState, saveState, stampSource, registrySetDrift } = helper;

const HERE = dirname(new URL(import.meta.url).pathname);
const REGISTRY = join(HERE, "..", "Data", "sources.json");
const STATE = join(HERE, "..", "State", "currency-state.json");

interface Registry {
  sources: Array<{ id: string; current_version?: string; [k: string]: unknown }>;
}

function loadRegistry(): Registry {
  return JSON.parse(readFileSync(REGISTRY, "utf8")) as Registry;
}

// ── Skill-owned fetch: observe installed versions from pdtm ───────────────────
/** Parse `pdtm -list` output into {tool: version}. Lines look like "subfinder v2.6.6 (latest)". */
export function parsePdtmList(out: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*([a-z0-9-]+)\s+(v?\d[\w.\-+]*)/i);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

/** Returns {} when pdtm is absent, so a missing toolchain degrades to "unknown", never a fake change. */
export function observeVersions(): Record<string, string> {
  try {
    const out = execFileSync("pdtm", ["-list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parsePdtmList(out);
  } catch {
    return {};
  }
}

// ── The check: diff observed vs stamped state. NEVER mutates. ─────────────────
export interface ToolChange {
  tool: string;
  kind: string;
  prev: string | null;
  next: string | null;
  tier: string;
}

export function check(registry: Registry, state: CurrencyState, observed: Record<string, string>): ToolChange[] {
  const changes: ToolChange[] = [];
  for (const s of registry.sources) {
    const obs = observed[s.id];
    if (obs === undefined) continue; // not observed → unknown, not a change; never fabricate
    const c = diff({ version: obs }, state.sources[s.id] ?? null);
    if (c.changed) {
      // A change is a fact, not a method edit, so it warns and lands autonomously
      // on an explicit stamp. impliesMethod stays the operator's call, defaulted false here.
      const tier = classifyChange(c, { impliesMethod: false });
      changes.push({ tool: s.id, kind: c.kind, prev: c.prev, next: c.next, tier });
    }
  }
  return changes;
}

/** Set-drift: a tool observed but not in the registry (new), or registered but not observed (removed). */
export function setDrift(registry: Registry, observed: Record<string, string>): { added: string[]; removed: string[] } {
  return registrySetDrift(registry.sources.map((s) => s.id), Object.keys(observed));
}

// ── Stamp: record installed versions after an explicit update. Mutates state. ─
export function stamp(
  registry: Registry,
  state: CurrencyState,
  observed: Record<string, string>,
  now?: Date,
): CurrencyState {
  for (const s of registry.sources) {
    const obs = observed[s.id];
    if (obs === undefined) continue;
    stampSource(state, s.id, { version: obs }, now);
  }
  return state;
}

// ── Self-test (deterministic, no pdtm) ───────────────────────────────────────
function runTests(): number {
  let passed = 0;
  let failed = 0;
  const ok = (name: string, cond: boolean) => {
    cond ? passed++ : failed++;
    console.log(`  ${cond ? "✓" : "✗"} ${name}`);
  };

  const reg = loadRegistry();
  ok("registry has 21 sources", reg.sources.length === 21);

  // Exercise the parser (the one skill-specific line) against a representative pdtm -list
  // fixture, since live pdtm is unavailable here. The injection seam is raw output, not a parsed map.
  const pdtmSample = [
    "subfinder          v2.6.6   (latest)",
    "httpx              v1.6.9   (outdated)",
    "chaos-client       v0.5.1   (latest)",
    "interactsh-client  v1.2.4   (latest)",
    "",
  ].join("\n");
  const parsed = parsePdtmList(pdtmSample);
  ok("parsePdtmList parses representative fixture incl. hyphenated names", parsed.subfinder === "v2.6.6" && parsed.httpx === "v1.6.9" && parsed["chaos-client"] === "v0.5.1" && parsed["interactsh-client"] === "v1.2.4" && Object.keys(parsed).length === 4);

  const obs1 = { subfinder: "v2.6.6", httpx: "v1.6.0", nuclei: "v3.3.0" };
  const state: CurrencyState = { last_check_timestamp: null, sources: {} };

  // ISC-4: first-run for every observed tool; no mutation on check
  const first = check(reg, state, obs1);
  ok("ISC-4: check reports first-run for all observed", first.length === 3 && first.every((c) => c.kind === "first-run"));
  ok("ISC-4: check does not mutate state", Object.keys(state.sources).length === 0);

  // ISC-5: stamp records observed versions
  stamp(reg, state, obs1, new Date("2026-07-11T00:00:00Z"));
  ok("ISC-5: stamp records versions", state.sources.subfinder?.current_version === "v2.6.6" && state.sources.nuclei?.current_version === "v3.3.0");
  ok("ISC-5: stamp sets last_check_timestamp", state.last_check_timestamp === "2026-07-11T00:00:00.000Z");

  // ISC-6: re-check with same observed → zero changes
  ok("ISC-6: re-check reports no change", check(reg, state, obs1).length === 0);

  // ISC-7: one version bump → exactly that one change
  const obs2 = { ...obs1, nuclei: "v3.4.0" };
  const delta = check(reg, state, obs2);
  ok("ISC-7: one bump → one change", delta.length === 1 && delta[0].tool === "nuclei" && delta[0].kind === "version" && delta[0].next === "v3.4.0");

  // ISC-11: the change lands autonomous by default; no method inference in check
  ok("ISC-11: fact change classifies autonomous", delta[0].tier === "autonomous");

  // set-drift: a tool appearing that is not registered, and a registered tool not observed
  const sd = setDrift(reg, { subfinder: "v2.6.6", newtool: "v9.9.9" });
  ok("set-drift flags a new tool not in registry", sd.added.includes("newtool"));
  ok("set-drift flags a registered tool not observed", sd.removed.includes("httpx"));

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed === 0 ? "✓ ToolCurrency self-test PASSED" : "✗ ToolCurrency self-test FAILED");
  return failed === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const cmd = process.argv[2];
  switch (cmd) {
    case "test":
      process.exit(runTests());
      break;
    case "check": {
      const reg = loadRegistry();
      const state = loadState(STATE);
      const observed = observeVersions();
      if (Object.keys(observed).length === 0) {
        console.log("pdtm not available or no tools installed — nothing observed. (check is read-only; no state changed.)");
        break;
      }
      const changes = check(reg, state, observed);
      if (changes.length === 0) {
        console.log(`OK: all observed tools match stamped state (last stamp: ${state.last_check_timestamp ?? "never"}).`);
      } else {
        console.log(`STALE: ${changes.length} tool(s) drifted from stamped state. Review, then update explicitly and re-stamp.`);
        for (const c of changes) console.log(`  - ${c.tool}: ${c.prev ?? "(unstamped)"} → ${c.next} [${c.kind}]`);
        console.log("This is a warning only. No versions were changed.");
      }
      const sd = setDrift(reg, observed);
      if (sd.added.length) console.log(`NEW tools observed but not in registry (add them): ${sd.added.join(", ")}`);
      if (sd.removed.length) console.log(`Registry tools not observed (removed or not installed): ${sd.removed.join(", ")}`);
      break;
    }
    case "stamp": {
      const reg = loadRegistry();
      const state = loadState(STATE);
      const observed = observeVersions();
      if (Object.keys(observed).length === 0) {
        console.log("pdtm not available — nothing to stamp.");
        break;
      }
      stamp(reg, state, observed);
      saveState(STATE, state);
      console.log(`Stamped ${Object.keys(observed).length} tool version(s) into ${STATE}.`);
      break;
    }
    case "status": {
      const state = loadState(STATE);
      console.log(`last check: ${state.last_check_timestamp ?? "never"}`);
      for (const [id, rec] of Object.entries(state.sources)) console.log(`  ${id}: ${rec.current_version ?? "?"} (stamped ${rec.last_checked})`);
      break;
    }
    default:
      console.log("ToolCurrency.ts — Recon toolchain currency. Commands: check | stamp | status | test");
      console.log("Contract: LIFEOS/DOCUMENTATION/Currency/CurrencySystem.md");
  }
}
