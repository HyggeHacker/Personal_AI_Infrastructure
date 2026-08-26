/**
 * proposal-approvals — the channel-agnostic approval surface for human-gated
 * memory proposals and skill-lessons.
 *
 * This is the surface + reply-routing arm that used to live inside the Telegram
 * module. Upstream v7.40.4 deleted that transport (grammy, telegram-proposals,
 * telegram-sessions) in favour of iMessage/Hermes/Conduit, which stranded the
 * approval half of the curation loop: the reviewer still enqueued rows into
 * `pending-proposals.jsonl` / `pending-skill-lessons.jsonl`, but nothing
 * surfaced them and no reply could resolve them. This lib re-homes that arm
 * with the transport injected as a `send(text)` function, so the next channel
 * swap costs one glue call instead of a rewrite.
 *
 * Two queues, one grammar:
 *   - identity proposals — lifecycle owned by ../lib/memory-proposals
 *     (acceptProposal/rejectProposal/editProposal are the sanctioned decision
 *     writers; this lib never hand-rolls those transitions)
 *   - skill-lessons — own queue + apply arm in ../lib/telegram-skill-lessons
 *     (isolated file so a queue rewrite can't drop foreign rows)
 *
 * The reply grammar is `yes/no/edit #id` + `proposals` + `lessons`
 * (parseProposalReply, from memory-proposals). Routing checks the skill-lesson
 * queue FIRST and falls through to identity proposals when the id isn't ours,
 * exactly as the Telegram handler did.
 *
 * Safety posture: every apply here happens ONLY on an explicit human reply.
 * Nothing in this file auto-applies a proposal — the auto-apply path (if the
 * principal enables it) lives in the reviewer, not the surface.
 */

import {
  acceptProposal,
  editProposal,
  formatProposalMessage,
  loadProposalQueue,
  logProposalReply,
  markProposal,
  parseProposalReply,
  pendingProposals,
  rejectProposal,
  type ProposalReply,
} from "./memory-proposals";
import {
  applySkillLesson,
  formatSkillLessonMessage,
  loadSkillLessonQueue,
  logSkillLessonReply,
  markSkillLesson,
  type SkillLessonRow,
} from "./telegram-skill-lessons";

/** Transport hook: deliver one plain-text message to the principal. */
export type SendFn = (text: string) => Promise<boolean>;

export interface ApprovalOptions {
  /** Observability tag written into the reply logs (e.g. "imessage"). */
  channel: string;
  /** Override queue paths / skills root — used by tests; production takes the defaults. */
  proposalsPath?: string;
  lessonsPath?: string;
  skillsRoot?: string;
}

// ── Drain: surface pending rows to the principal ──

async function surfaceProposals(send: SendFn, max: number, opts: ApprovalOptions): Promise<number> {
  const pending = pendingProposals(opts.proposalsPath).filter((r) => r.status === "pending");
  let sent = 0;
  for (const row of pending.slice(0, max)) {
    if (await send(formatProposalMessage(row))) {
      markProposal(row.id, { status: "sent", surfaced_at: new Date().toISOString() }, opts.proposalsPath);
      logProposalReply({ id: row.id, status: "sent", channel: opts.channel });
      sent += 1;
    }
  }
  return sent;
}

async function surfaceSkillLessons(send: SendFn, max: number, opts: ApprovalOptions): Promise<number> {
  const pending = loadSkillLessonQueue(opts.lessonsPath).filter((r) => r.status === "pending");
  let sent = 0;
  for (const row of pending.slice(0, max)) {
    if (await send(formatSkillLessonMessage(row))) {
      markSkillLesson(row.id, { status: "sent", surfaced_at: new Date().toISOString() }, opts.lessonsPath);
      logSkillLessonReply({ id: row.id, skill: row.skill, status: "sent", channel: opts.channel });
      sent += 1;
    }
  }
  return sent;
}

/**
 * Surface up to `maxPerKind` pending identity proposals and skill-lessons.
 * Idempotent: a surfaced row is marked `sent` and never re-sent by the drain
 * (the `proposals` / `lessons` list commands re-show sent rows on demand).
 *
 * Call this from a timer or any recurring event. The old Telegram drain fired
 * ONLY piggy-backed on inbound messages — a proposal enqueued while the chat
 * was quiet sat invisible until the principal happened to text. A timer-driven
 * caller removes that limitation.
 */
export async function drainPendingApprovals(
  send: SendFn,
  opts: ApprovalOptions,
  maxPerKind: number = 1,
): Promise<number> {
  const a = await surfaceProposals(send, maxPerKind, opts);
  const b = await surfaceSkillLessons(send, maxPerKind, opts);
  return a + b;
}

// ── Reply routing ──

async function listProposals(send: SendFn, opts: ApprovalOptions): Promise<void> {
  const showable = loadProposalQueue(opts.proposalsPath).filter(
    (r) => r.status === "pending" || r.status === "sent",
  );
  if (showable.length === 0) {
    await send("📋 No pending proposals.");
    return;
  }
  for (const row of showable) {
    await send(formatProposalMessage(row));
    if (row.status === "pending") {
      markProposal(row.id, { status: "sent", surfaced_at: new Date().toISOString() }, opts.proposalsPath);
    }
  }
  logProposalReply({ kind: "list", count: showable.length, channel: opts.channel });
}

async function listSkillLessons(send: SendFn, opts: ApprovalOptions): Promise<void> {
  const showable = loadSkillLessonQueue(opts.lessonsPath).filter(
    (r) => r.status === "pending" || r.status === "sent",
  );
  if (showable.length === 0) {
    await send("🧩 No pending skill-lessons.");
    return;
  }
  for (const row of showable) {
    await send(formatSkillLessonMessage(row));
    if (row.status === "pending") {
      markSkillLesson(row.id, { status: "sent", surfaced_at: new Date().toISOString() }, opts.lessonsPath);
    }
  }
  logSkillLessonReply({ kind: "list", count: showable.length, channel: opts.channel });
}

// Skill-lesson decisions keep the hand-rolled transitions from the Telegram
// handler (mark + apply + log) because telegram-skill-lessons exposes no
// decision writers; identity proposals below use the memory-proposals ones.
async function handleSkillLessonReply(
  reply: ProposalReply,
  send: SendFn,
  opts: ApprovalOptions,
): Promise<"handled" | "passthrough"> {
  if (reply.kind === null || reply.kind === "list") return "passthrough";
  const row = loadSkillLessonQueue(opts.lessonsPath).find((r) => r.id === reply.id);
  if (!row) return "passthrough"; // not a skill-lesson id — let identity proposals try
  if (row.status !== "pending" && row.status !== "sent") {
    await send(`🤷 Skill-lesson #${row.id} is already ${row.status}.`);
    return "handled";
  }

  if (reply.kind === "no") {
    markSkillLesson(row.id, { status: "rejected", resolved_at: new Date().toISOString() }, opts.lessonsPath);
    logSkillLessonReply({ kind: "no", id: row.id, skill: row.skill, outcome: "rejected", channel: opts.channel });
    await send("🚫 Discarded skill-lesson.");
    return "handled";
  }

  const lessonText = reply.kind === "edit" ? reply.editText : row.lesson;
  if (reply.kind === "edit" && (!lessonText || lessonText.length === 0)) {
    await send(`✏️ Provide the edited lesson: \`edit #${reply.id} <your text>\``);
    return "handled";
  }
  const result = opts.skillsRoot
    ? applySkillLesson(row.skill, lessonText, row.provenance, opts.skillsRoot)
    : applySkillLesson(row.skill, lessonText, row.provenance);
  if (result.ok) {
    const status = reply.kind === "edit" ? "edited" : "accepted";
    markSkillLesson(row.id, { status, resolved_at: new Date().toISOString(), applied_lesson: lessonText }, opts.lessonsPath);
    logSkillLessonReply({ kind: reply.kind, id: row.id, skill: row.skill, outcome: result.skipped ? "duplicate-skipped" : "applied", channel: opts.channel });
    const note = result.skipped
      ? `already in ${row.skill}'s Gotchas (skipped duplicate)`
      : `landed in ${row.skill}'s ## Gotchas`;
    await send(`✅ ${note}`);
  } else {
    logSkillLessonReply({ kind: reply.kind, id: row.id, skill: row.skill, outcome: "apply-failed", reason: result.reason, channel: opts.channel });
    await send(`❌ Couldn't apply skill-lesson: ${result.reason}`);
  }
  return "handled";
}

async function handleIdentityProposalReply(
  reply: ProposalReply,
  send: SendFn,
  opts: ApprovalOptions,
): Promise<"handled"> {
  const kind = reply.kind as "yes" | "no" | "edit";
  const id = (reply as { id: string }).id;

  if (kind === "edit") {
    const editText = (reply as { editText: string }).editText;
    if (!editText || editText.length === 0) {
      await send(`✏️ Provide the edited text: \`edit #${id} <your text>\``);
      return "handled";
    }
    const r = editProposal(id, editText, opts.proposalsPath);
    logProposalReply({ kind, id, outcome: r.ok ? "applied" : "apply-failed", ...(r.ok ? {} : { reason: r.reason }), channel: opts.channel });
    await send(r.ok ? `✅ Applied your edit to ${r.row!.target_file}` : `❌ Couldn't apply: ${r.reason}`);
    return "handled";
  }

  if (kind === "no") {
    const r = rejectProposal(id, opts.proposalsPath);
    logProposalReply({ kind, id, outcome: r.ok ? "rejected" : "reject-failed", ...(r.ok ? {} : { reason: r.reason }), channel: opts.channel });
    await send(r.ok ? "🚫 Discarded." : `❌ ${r.reason}`);
    return "handled";
  }

  const r = acceptProposal(id, opts.proposalsPath);
  logProposalReply({ kind, id, outcome: r.ok ? "applied" : "apply-failed", ...(r.ok ? {} : { reason: r.reason }), channel: opts.channel });
  await send(r.ok ? `✅ Applied to ${r.row!.target_file}` : `❌ Couldn't apply: ${r.reason}`);
  return "handled";
}

/**
 * Route one inbound message through the approval grammar.
 *
 * Returns "handled" when the message was an approval command (a confirmation
 * has been sent); "passthrough" when it is ordinary conversation the caller
 * should process normally. Deterministic — no model in the loop, so an
 * approval reply resolves even while an SDK turn is busy.
 */
export async function handleApprovalReply(
  text: string,
  send: SendFn,
  opts: ApprovalOptions,
): Promise<"handled" | "passthrough"> {
  if (/^lessons?$/i.test(text.trim())) {
    await listSkillLessons(send, opts);
    return "handled";
  }

  const reply = parseProposalReply(text);
  if (reply.kind === null) return "passthrough";

  if (reply.kind === "list") {
    await listProposals(send, opts);
    return "handled";
  }

  // Skill-lesson queue first; unknown ids fall through to identity proposals.
  const slOutcome = await handleSkillLessonReply(reply, send, opts);
  if (slOutcome === "handled") return "handled";

  const row = loadProposalQueue(opts.proposalsPath).find((r) => r.id === reply.id);
  if (!row) {
    await send(`🤷 No proposal with id #${reply.id}. Try \`proposals\` to list pending ones.`);
    logProposalReply({ kind: reply.kind, id: reply.id, outcome: "id-not-found", channel: opts.channel });
    return "handled";
  }
  return handleIdentityProposalReply(reply, send, opts);
}
