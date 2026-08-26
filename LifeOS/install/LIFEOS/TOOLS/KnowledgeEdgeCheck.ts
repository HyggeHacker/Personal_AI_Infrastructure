#!/usr/bin/env bun
/**
 * KnowledgeEdgeCheck — validate (and optionally repair) `related:` edges in the
 * Knowledge Archive.
 *
 * WHY (2026-08-26): `KnowledgeGraph` DROPS an edge whose target resolves to no
 * node — silently. So a typo, a case mismatch, or a link to something that was
 * never a node degrades recall with no error anywhere. The SessionStart banner
 * counted them but nothing could explain or fix them.
 *
 * Three classes, and only the first two are mechanical:
 *   CASE      target matches a real slug case-insensitively  → repairable
 *   SKILL     target is a skill name (`_FOO`, or a known skill slug), not a node.
 *             The graph and the skill registry were conflated at authoring time.
 *             Repair moves it out of `related:` into `skills:`, preserving the
 *             information while removing it from the graph.
 *   MISSING   no node exists at any case. NOT auto-repaired: the fix is either to
 *             write the node or to delete the edge, and both are judgment calls.
 *
 * Usage:
 *   bun KnowledgeEdgeCheck.ts              # report, exit 1 if any dangling
 *   bun KnowledgeEdgeCheck.ts --fix        # repair CASE + SKILL, leave MISSING
 *   bun KnowledgeEdgeCheck.ts --json
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LIFEOS = process.env.LIFEOS_DIR || join(homedir(), ".claude", "LIFEOS");
const K = join(LIFEOS, "MEMORY", "KNOWLEDGE");
const SKILLS = join(homedir(), ".claude", "skills");

const FIX = process.argv.includes("--fix");
const JSON_OUT = process.argv.includes("--json");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

function frontmatter(txt: string): string {
  if (!txt.startsWith("---")) return "";
  const end = txt.indexOf("\n---", 3);
  return end > 0 ? txt.slice(3, end) : "";
}

const files = existsSync(K) ? walk(K) : [];
const slugOf = new Map<string, string>();
for (const p of files) {
  const fm = frontmatter(readFileSync(p, "utf-8"));
  const m = fm.match(/^slug:\s*["']?([^"'\n]+)/m);
  const slug = (m ? m[1] : p.split("/").pop()!.replace(/\.md$/, "")).trim();
  slugOf.set(slug, p);
  slugOf.set(p.split("/").pop()!.replace(/\.md$/, ""), p);
}
const lower = new Map([...slugOf.keys()].map((s) => [s.toLowerCase(), s]));
const skillNames = new Set(existsSync(SKILLS) ? readdirSync(SKILLS) : []);
const skillLower = new Set([...skillNames].map((s) => s.toLowerCase()));

type Cls = "CASE" | "SKILL" | "MISSING";
const findings: { file: string; src: string; target: string; cls: Cls; fixTo?: string }[] = [];

for (const p of files) {
  const txt = readFileSync(p, "utf-8");
  const fm = frontmatter(txt);
  const src = (fm.match(/^slug:\s*(.+)$/m)?.[1] ?? "").trim() || p.split("/").pop()!;
  const block = fm.match(/^related:\s*([\s\S]*?)(?=^[A-Za-z_]+:|\Z)/m)?.[1];
  if (!block) continue;
  for (const m of block.matchAll(/-\s*slug:\s*["']?([^"'\n]+)/g)) {
    const t = m[1].trim();
    if (slugOf.has(t)) continue;
    // SKILL only on a WHOLE-name match, never a first-segment one. Matching the
    // leading segment classified `arxiv-2607-05743-adjacent-paper` as the ArXiv
    // skill — a knowledge note about a paper is not a skill reference. The
    // `-skill` suffix form (`interceptor-skill`) is a real authoring habit here.
    const whole = t.toLowerCase();
    const desuffixed = whole.replace(/-skill$/, "");
    let cls: Cls = "MISSING";
    let fixTo: string | undefined;
    if (lower.has(whole)) { cls = "CASE"; fixTo = lower.get(whole); }
    else if (t.startsWith("_") || skillLower.has(whole) || skillLower.has(desuffixed)) cls = "SKILL";
    findings.push({ file: p, src, target: t, cls, fixTo });
  }
}

if (FIX) {
  const byFile = new Map<string, typeof findings>();
  for (const f of findings) if (f.cls !== "MISSING") {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }
  for (const [p, fs] of byFile) {
    let txt = readFileSync(p, "utf-8");
    const moved: string[] = [];
    for (const f of fs) {
      if (f.cls === "CASE" && f.fixTo) {
        txt = txt.replace(new RegExp(`(-\\s*slug:\\s*["']?)${f.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `$1${f.fixTo}`);
      } else if (f.cls === "SKILL") {
        // Drop the whole list item, remember it for the skills: field.
        txt = txt.replace(new RegExp(`^\\s*-\\s*slug:\\s*["']?${f.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?[^\\n]*\\n(?:\\s{4,}[^\\n]*\\n)*`, "m"), "");
        moved.push(f.target);
      }
    }
    if (moved.length) {
      const end = txt.indexOf("\n---", 3);
      const existing = txt.slice(0, end).match(/^skills:\s*\[([^\]]*)\]/m);
      if (existing) {
        const merged = [...new Set([...existing[1].split(",").map((s) => s.trim()).filter(Boolean), ...moved])];
        txt = txt.slice(0, end).replace(/^skills:\s*\[[^\]]*\]/m, `skills: [${merged.join(", ")}]`) + txt.slice(end);
      } else {
        txt = txt.slice(0, end) + `\nskills: [${moved.join(", ")}]` + txt.slice(end);
      }
    }
    writeFileSync(p, txt, "utf-8");
  }
}

const counts = { CASE: 0, SKILL: 0, MISSING: 0 } as Record<Cls, number>;
for (const f of findings) counts[f.cls]++;

if (JSON_OUT) {
  console.log(JSON.stringify({ nodes: files.length, findings, counts }, null, 2));
} else {
  console.log(`${FIX ? "FIXED" : "CHECK"} · ${files.length} nodes · dangling ${findings.length} (CASE ${counts.CASE}, SKILL ${counts.SKILL}, MISSING ${counts.MISSING})`);
  for (const cls of ["CASE", "SKILL", "MISSING"] as Cls[]) {
    const g = findings.filter((f) => f.cls === cls);
    if (!g.length) continue;
    console.log(`\n  ── ${cls} ──`);
    for (const f of g) console.log(`    ${f.target.padEnd(42)} <- ${f.src}${f.fixTo ? `   → ${f.fixTo}` : ""}`);
  }
  if (counts.MISSING) console.log(`\n  MISSING is not auto-repaired: write the node, or delete the edge. Both are judgment calls.`);
}

process.exit(findings.length && !FIX ? 1 : 0);
