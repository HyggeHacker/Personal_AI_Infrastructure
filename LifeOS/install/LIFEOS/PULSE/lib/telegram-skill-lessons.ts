/**
 * ── LIFEOS-PRIVATE (skill-lesson) ── (whole file; see danielmiessler/LifeOS#1450)
 *
 * telegram-skill-lessons — the surface + apply arm of the inward-arrow loop.
 *
 * Skill-lessons live in their OWN queue (`pending-skill-lessons.jsonl`), NOT the
 * identity-proposal queue, because the identity consumer (memory-proposals.ts
 * loadProposalQueue → writeProposalQueue) filters to target_file+edit rows and
 * REWRITES the file from that filtered set, which would silently drop a foreign
 * skill-lesson row. This module is the isolated reader/surfacer/applier for that
 * queue. It reuses the identity `yes/no/edit #id` grammar (parseProposalReply)
 * so the principal's muscle memory carries over.
 *
 * The apply arm (`applySkillLesson`) implements the ImproveSkill "MERGE mode"
 * Gotchas contract deterministically: land one bullet in the skill's `## Gotchas`
 * section, stamped with provenance, skipping a near-duplicate. It writes SKILL.md
 * ONLY from the human approval path — the caller is the channel reply handler
 * (lib/proposal-approvals.ts, surfaced over iMessage), a human-gated actor.
 * No hook or autonomous reviewer imports this. SKILL.md
 * stays Tier D; this is the authorized apply actor, not the autonomous reviewer.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { PENDING_SKILL_LESSONS_PATH } from "../../TOOLS/MemoryTypes";
// The identity reply grammar used to be re-exported from ./telegram-proposals,
// which upstream v7.40.4 deleted with the rest of the Telegram pipeline. Its
// successor lives in ./memory-proposals (formerly telegram-proposals), which
// carries the separator-required fix from public issue #1844 — an inlined copy
// here briefly reintroduced the zero-length-separator bug ("Non ..." parsing as
// {kind:"no"}). Re-exported so existing importers keep their surface while one
// grammar remains authoritative. (2026-08-25)
export { parseProposalReply, type ProposalReply } from "./memory-proposals";

const HOME = process.env.HOME ?? homedir();
const CLAUDE_ROOT = pathResolve(HOME, ".claude");
const SKILLS_ROOT = join(CLAUDE_ROOT, "skills");
const OBS_DIR = join(CLAUDE_ROOT, "LIFEOS", "MEMORY", "OBSERVABILITY");
const SKILL_LESSON_REPLIES_LOG = join(OBS_DIR, "skill-lesson-replies.jsonl");

export interface SkillLessonProvenanceRow {
  ts: string;
  session_id?: string | null;
  model?: string;
  signal: string;
}

export interface SkillLessonRow {
  id: string;
  ts: string;
  status: "pending" | "sent" | "accepted" | "rejected" | "edited";
  kind: "skill-lesson";
  skill: string;
  target_section: string;
  lesson: string;
  signal: string;
  signal_hash: string;
  confidence: number;
  provenance: SkillLessonProvenanceRow;
  source_session?: string | null;
  surfaced_at?: string;
  resolved_at?: string;
  applied_lesson?: string;
}

// ── Queue I/O (own file; foreign-row-safe: only touches pending-skill-lessons.jsonl) ──

export function loadSkillLessonQueue(path: string = PENDING_SKILL_LESSONS_PATH): SkillLessonRow[] {
  if (!existsSync(path)) return [];
  try {
    const rows: SkillLessonRow[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const row = JSON.parse(s) as Partial<SkillLessonRow>;
        if (row.id && row.skill && row.lesson && row.status && row.kind === "skill-lesson") {
          rows.push(row as SkillLessonRow);
        }
      } catch { /* skip malformed */ }
    }
    return rows;
  } catch {
    return [];
  }
}

export function writeSkillLessonQueue(rows: SkillLessonRow[], path: string = PENDING_SKILL_LESSONS_PATH): void {
  const tmp = `${path}.tmp`;
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

export function markSkillLesson(id: string, patch: Partial<SkillLessonRow>, path: string = PENDING_SKILL_LESSONS_PATH): SkillLessonRow | null {
  const rows = loadSkillLessonQueue(path);
  let matched: SkillLessonRow | null = null;
  for (const r of rows) {
    if (r.id === id) { Object.assign(r, patch); matched = r; break; }
  }
  if (matched) writeSkillLessonQueue(rows, path);
  return matched;
}

export function logSkillLessonReply(event: Record<string, unknown>, path: string = SKILL_LESSON_REPLIES_LOG): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch { /* best-effort */ }
}

export function formatSkillLessonMessage(r: SkillLessonRow): string {
  // Surface the triggering signal prominently and label the confidence honestly:
  // it measures temporal ATTRIBUTION uniqueness (one skill in the window), NOT
  // that the skill caused the low rating. The human judges causality, not us —
  // an overstated "high confidence" would prime a rubber-stamp (Advisor 2026-07-10).
  return [
    `🧩 [skill-lesson] ${r.skill} learned a lesson (→ ## ${r.target_section}):`,
    `"${r.lesson}"`,
    `— signal ${r.signal}; attribution: unique-in-window (conf ${r.confidence.toFixed(2)}). Judge the cause before approving.`,
    `Reply: yes #${r.id} / no #${r.id} / edit #${r.id} <text>`,
  ].join("\n");
}

// ── Apply arm: deterministic ImproveSkill MERGE-mode Gotchas landing ──

/**
 * Resolve a skill name to its SKILL.md, or null if the name is unsafe or the
 * file does not exist. Guards against path traversal (the name must be a bare
 * skill slug) and against creating a SKILL.md from nothing (existsSync required).
 */
export function resolveSkillMdPath(skill: string, skillsRoot: string = SKILLS_ROOT): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(skill)) return null;           // no separators, no traversal
  const p = pathResolve(skillsRoot, skill, "SKILL.md");
  if (!p.startsWith(skillsRoot + "/")) return null;           // must stay under skills/
  if (!existsSync(p)) return null;                            // never create from nothing
  return p;
}

function normalizeBullet(s: string): string {
  return s.replace(/<!--.*?-->/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const MAX_LESSON_LEN = 300;

/**
 * Neutralize a lesson before it becomes bytes in executable instruction. The
 * lesson text is model-authored from conversation content, so it is prompt-
 * injectable upstream (Advisor 2026-07-10). Collapse to a single line (kills
 * `\n## ` heading injection), strip HTML-comment markers (kills `-->` escaping
 * the provenance stamp) and code-fence markers, and length-cap. Applied to BOTH
 * the `yes` (queued lesson) and `edit` (arbitrary Telegram text) paths.
 */
export function sanitizeLesson(text: string): string {
  return text
    .replace(/\r?\n+/g, " ")
    .replace(/<!--|-->/g, "")
    .replace(/`{3,}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LESSON_LEN);
}

const BACKUP_DIR = join(CLAUDE_ROOT, "LIFEOS", "MEMORY", "OBSERVABILITY", "skill-lesson-backups");

/** Snapshot SKILL.md before an approval write — ~/.claude is not git, so this is the revert path. */
function snapshotBeforeWrite(skill: string, current: string): void {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(BACKUP_DIR, `${skill}-${stamp}.md`), current, "utf8");
  } catch { /* best-effort; never block the approval on a backup failure */ }
}

/**
 * Land one lesson into the skill's `## Gotchas` section, merged (a near-duplicate
 * bullet is skipped, never stacked), stamped with a provenance HTML comment.
 * Creates the section at end-of-file if absent. Returns a typed result.
 */
export function applySkillLesson(
  skill: string,
  lessonText: string,
  provenance: SkillLessonProvenanceRow,
  skillsRoot: string = SKILLS_ROOT,
): { ok: true; skipped?: "duplicate" } | { ok: false; reason: string } {
  const path = resolveSkillMdPath(skill, skillsRoot);
  if (!path) return { ok: false, reason: `unsafe or missing SKILL.md for skill '${skill}'` };
  const lesson = sanitizeLesson(lessonText);
  if (!lesson) return { ok: false, reason: "empty lesson" };

  try {
    const current = readFileSync(path, "utf8");
    const stamp = `<!-- skill-lesson: signal=${provenance.signal} run=${provenance.session_id ?? "?"} model=${provenance.model ?? "?"} applied=${new Date().toISOString()} -->`;
    const bullet = `- ${lesson} ${stamp}`;
    const header = "## Gotchas";

    if (current.includes(header)) {
      // Slice out the Gotchas section body to dedup against existing bullets.
      const startIdx = current.indexOf(header) + header.length;
      const rest = current.slice(startIdx);
      const nextHeaderRel = rest.search(/\n## /);
      const sectionBody = nextHeaderRel === -1 ? rest : rest.slice(0, nextHeaderRel);
      const normNew = normalizeBullet(bullet);
      for (const line of sectionBody.split("\n")) {
        if (line.trim().startsWith("- ") && normalizeBullet(line) === normNew) {
          return { ok: true, skipped: "duplicate" };
        }
      }
      const insertAt = nextHeaderRel === -1 ? current.length : startIdx + nextHeaderRel;
      const before = current.slice(0, insertAt).replace(/\s+$/, "");
      const after = current.slice(insertAt);
      const next = `${before}\n${bullet}\n${after.startsWith("\n") ? after.slice(1) : after}`;
      snapshotBeforeWrite(skill, current);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, next, "utf8");
      renameSync(tmp, path);
      return { ok: true };
    }

    // No Gotchas section — create one at end of file.
    const next = current.replace(/\s+$/, "") + `\n\n${header}\n\n${bullet}\n`;
    snapshotBeforeWrite(skill, current);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, path);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? String(e) };
  }
}

// ── Self-test ──

function selfTest(): number {
  console.log("telegram-skill-lessons self-test starting…");
  let pass = 0, fail = 0;
  const check = (name: string, ok: boolean, detail?: string) => {
    if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
    else    { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
  };

  const tmpQueue = "/tmp/claude-501/sl-queue.test.jsonl";
  const tmpSkills = "/tmp/claude-501/sl-skills-test";
  const skillDir = join(tmpSkills, "_DEMO_SKILL");
  mkdirSync(skillDir, { recursive: true });
  const skillMd = join(skillDir, "SKILL.md");

  const prov: SkillLessonProvenanceRow = { ts: "2026-07-10T12:00:00Z", session_id: "s1", model: "claude-fable-5", signal: "low-rating:3" };
  const row: SkillLessonRow = {
    id: "abc123", ts: "2026-07-10T12:00:00Z", status: "pending", kind: "skill-lesson",
    skill: "_DEMO_SKILL", target_section: "Gotchas", lesson: "verify the token scope before deploy",
    signal: "low-rating:3", signal_hash: "hash1", confidence: 0.7, provenance: prov,
  };

  // ISC-15: queue round-trip isolated to its own file
  writeSkillLessonQueue([row], tmpQueue);
  const loaded = loadSkillLessonQueue(tmpQueue);
  check("ISC-15: load/write round-trips skill-lesson rows", loaded.length === 1 && loaded[0].skill === "_DEMO_SKILL");
  markSkillLesson("abc123", { status: "accepted" }, tmpQueue);
  check("ISC-15: markSkillLesson updates status", loadSkillLessonQueue(tmpQueue)[0].status === "accepted");

  // ISC-16: message renders skill/section/lesson/id
  const msg = formatSkillLessonMessage(row);
  check("ISC-16: message shows skill, section, lesson, yes/no/edit #id",
    msg.includes("_DEMO_SKILL") && msg.includes("## Gotchas".slice(3)) && msg.includes(row.lesson) && msg.includes("yes #abc123"));

  // ISC-18: apply creates the Gotchas section when absent, stamped
  writeFileSync(skillMd, "# _DEMO_SKILL\n\nA demo skill.\n\n## Workflows\n\n- Do\n", "utf8");
  const a1 = applySkillLesson("_DEMO_SKILL", "verify the token scope before deploy", prov, tmpSkills);
  const md1 = readFileSync(skillMd, "utf8");
  check("ISC-18: creates ## Gotchas with the bullet + provenance stamp",
    a1.ok && md1.includes("## Gotchas") && md1.includes("verify the token scope before deploy") && md1.includes("skill-lesson: signal=low-rating:3"));

  // ISC-18b: apply into an EXISTING Gotchas section inserts within it
  const a2 = applySkillLesson("_DEMO_SKILL", "always pass the region flag", prov, tmpSkills);
  const md2 = readFileSync(skillMd, "utf8");
  const gIdx = md2.indexOf("## Gotchas");
  check("ISC-18b: second bullet lands inside the Gotchas section",
    a2.ok && md2.indexOf("always pass the region flag") > gIdx);

  // ISC-19: near-duplicate is skipped, not stacked
  const beforeCount = (readFileSync(skillMd, "utf8").match(/verify the token scope before deploy/g) || []).length;
  const a3 = applySkillLesson("_DEMO_SKILL", "Verify the TOKEN scope before deploy!!", prov, tmpSkills);
  const afterCount = (readFileSync(skillMd, "utf8").match(/verify the token scope before deploy/gi) || []).length;
  check("ISC-19: near-duplicate skipped", a3.ok && (a3 as any).skipped === "duplicate" && afterCount === beforeCount);

  // ISC-19b: injection defense — malicious lesson lands neutralized (no heading/comment escape)
  const malicious = "innocent bullet\n## Injected Heading\n- extra bullet --> <!-- pwned";
  check("sanitizeLesson: strips newlines, comment markers", !sanitizeLesson(malicious).includes("\n") && !sanitizeLesson(malicious).includes("-->") && !sanitizeLesson(malicious).includes("<!--"));
  const a4 = applySkillLesson("_DEMO_SKILL", malicious, prov, tmpSkills);
  const md4 = readFileSync(skillMd, "utf8");
  // The threat is a new LINE-START heading, not the substring appearing inside a
  // bullet. Sanitize collapses to one line prefixed with "- ", so `## Injected`
  // survives only as inline bullet text (harmless) — line-start heading count is
  // unchanged, which is the property that matters.
  const headingCount = (md4.match(/^## /gm) || []).length;
  check("ISC-19b: malicious lesson injects no new line-start heading",
    a4.ok && headingCount === (md1.match(/^## /gm) || []).length && !/^## Injected/m.test(md4));
  // provenance stamp survived (the injected `-->` did not close it early)
  check("ISC-19b: provenance stamp intact after injection attempt", /model=claude-fable-5 applied=[^>]*-->/.test(md4));

  // pre-write snapshot exists after a real write
  check("snapshot: backup dir populated after approval write", existsSync(join(homedir(), ".claude", "LIFEOS", "MEMORY", "OBSERVABILITY", "skill-lesson-backups")));

  // ISC-20: unsafe skill name rejected (path traversal)
  const bad1 = applySkillLesson("../../etc/passwd", "x", prov, tmpSkills);
  check("ISC-20: path-traversal name rejected", !bad1.ok);
  const bad2 = applySkillLesson("NoSuchSkill", "x", prov, tmpSkills);
  check("ISC-20: missing SKILL.md rejected (no create-from-nothing)", !bad2.ok && !existsSync(join(tmpSkills, "NoSuchSkill", "SKILL.md")));
  check("ISC-20: resolveSkillMdPath returns null for separators", resolveSkillMdPath("a/b", tmpSkills) === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail === 0) { console.log("✓ telegram-skill-lessons self-test PASSED"); return 0; }
  console.error("✗ telegram-skill-lessons self-test FAILED");
  return 1;
}

if (import.meta.main) {
  if (process.argv[2] === "test") process.exit(selfTest());
  console.error("Usage: bun telegram-skill-lessons.ts test");
  process.exit(2);
}
