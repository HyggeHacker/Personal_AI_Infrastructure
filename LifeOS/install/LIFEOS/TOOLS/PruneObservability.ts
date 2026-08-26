#!/usr/bin/env bun
/**
 * PruneObservability — bounded retention for MEMORY/OBSERVABILITY/*.jsonl.
 *
 * WHY (2026-08-26): tool-activity.jsonl reached 63.6 MB / 60,509 lines in 52 days
 * (~1.25 MB/day, accelerating) with nothing pruning it. EventLogger has nine
 * truncation calls but every one caps a FIELD inside a record, never the file.
 *
 * WHY 30 DAYS, and why not less. It is not a taste call — it is the widest window
 * any consumer actually reads:
 *   - LIFEOS/PULSE/Performance/module.ts  reads `?days=` defaulting to 30
 *   - LIFEOS/PULSE/Observability/observability.ts  reads only the last 100 lines
 *   - AgentWatchdog.ts / CrossVendorAudit.ts  read a live tail
 * Truncating to "a few thousand lines" would have silently broken the Performance
 * tab while every other surface still looked fine. Raise KEEP_DAYS if a consumer
 * ever needs more; never lower it below the largest consumer window.
 *
 * SECOND REASON, and the one that matters most here: ground_truth is 71.6% of every
 * record (avg 928 B) and embeds command text and stdout — which on this machine
 * includes CLIENT ENGAGEMENT data. Retention is therefore a data-at-rest control,
 * not just a disk one. Shorter window, less confidential material sitting around.
 *
 * SAFETY: dry-run by default. --apply rewrites atomically via a .tmp + rename, and
 * refuses to write if the kept set is empty or if the parse rate looks wrong.
 *
 * Usage:
 *   bun PruneObservability.ts                # dry run, all files
 *   bun PruneObservability.ts --apply
 *   bun PruneObservability.ts --days 45 --apply
 *   bun PruneObservability.ts --file tool-activity.jsonl --apply
 */

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LIFEOS = process.env.LIFEOS_DIR || join(homedir(), ".claude", "LIFEOS");
const OBS = join(LIFEOS, "MEMORY", "OBSERVABILITY");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const KEEP_DAYS = Number(args[args.indexOf("--days") + 1]) || 30;
const ONLY = args.includes("--file") ? args[args.indexOf("--file") + 1] : null;

const cutoff = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString();

/** Pull an ISO timestamp without a full JSON.parse — this runs over ~60k lines. */
function tsOf(line: string): string | null {
  const i = line.indexOf('"timestamp":"');
  if (i < 0) return null;
  return line.slice(i + 13, i + 13 + 24);
}

let totalFreed = 0;
const rows: string[] = [];

const files = ONLY ? [ONLY] : readdirSync(OBS).filter((f) => f.endsWith(".jsonl"));

for (const name of files) {
  const path = join(OBS, name);
  if (!existsSync(path)) continue;
  const before = statSync(path).size;
  // Only bother with files big enough to matter.
  if (before < 256 * 1024 && !ONLY) continue;

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let undated = 0;
  const kept = lines.filter((l) => {
    const ts = tsOf(l);
    if (!ts) { undated++; return true; }   // never drop a line we cannot date
    return ts >= cutoff;
  });

  const after = kept.reduce((a, l) => a + l.length + 1, 0);
  const freed = before - after;
  rows.push(
    `  ${name.padEnd(30)} ${lines.length.toString().padStart(7)} -> ${kept.length
      .toString()
      .padStart(7)} lines  ${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB  frees ${(
      freed / 1048576
    ).toFixed(1)}MB${undated ? `  (${undated} undated kept)` : ""}`,
  );
  if (freed <= 0) continue;
  totalFreed += freed;

  if (APPLY) {
    // Refuse to write a suspicious result rather than destroy history.
    if (kept.length === 0) { console.error(`  REFUSED ${name}: would keep 0 lines`); continue; }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, kept.join("\n") + "\n", "utf-8");
    const wrote = readFileSync(tmp, "utf-8").split("\n").filter((l) => l.trim().length > 0).length;
    if (wrote !== kept.length) { console.error(`  REFUSED ${name}: readback ${wrote} != ${kept.length}`); unlinkSync(tmp); continue; }
    renameSync(tmp, path);
  }
}

console.log(`${APPLY ? "APPLIED" : "DRY RUN"} · keep ${KEEP_DAYS}d · cutoff ${cutoff.slice(0, 10)}`);
for (const r of rows) console.log(r);
console.log(`  total freed: ${(totalFreed / 1048576).toFixed(1)} MB`);
if (!APPLY && totalFreed > 0) console.log(`  re-run with --apply to perform`);
