# ImproveSkill Workflow

Improve an existing skill based on test feedback, user observations, or quality concerns. This is the revision half of the test-iterate loop.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ImproveSkill workflow in the CreateSkill skill to improve skill quality"}' \
  > /dev/null 2>&1 &
```

Running the **ImproveSkill** workflow in the **CreateSkill** skill to improve skill quality...

---

## Step 1: Gather Context

Read all available information:

1. **The skill:** Read the target SKILL.md and the specific workflow(s) relevant to the feedback
2. **Test results** (if from TestSkill): Read outputs from `MEMORY/WORK/skill-test-[name]/`
3. **User feedback:** What specific complaints or requests did the user have?
4. **Transcripts** (if available): How did the agent actually use the skill? Where did it waste time or go wrong?

---

## Step 2: Diagnose the Problem

Classify each piece of feedback:

| Feedback | Root Cause | Fix Type |
|----------|-----------|----------|
| "Output was wrong" | Unclear instructions | Rewrite for clarity |
| "Took too long" | Unproductive steps | Remove or simplify steps |
| "Missed edge case" | Gap in coverage | Add handling |
| "Too rigid" | Over-specified instructions | Explain the why instead |
| "Agents all wrote the same helper script" | Missing bundled tool | Add script to Tools/ |
| "Didn't trigger" | Description too narrow | Run OptimizeDescription |

---

## Step 3: Apply the Writing Philosophy

When rewriting skill instructions, follow these principles:

### Explain the Why, Not Just the What

Today's models are smart. They have good theory of mind and when given clear reasoning, they go beyond rote instructions. Instead of rigid rules, explain the reasoning so the model understands what matters.

Bad:
```
ALWAYS use exactly 3 bullet points. NEVER exceed 50 words per bullet.
MUST include a header. MUST NOT use passive voice.
```

Good:
```
Use bullet points to make key findings scannable — readers are busy executives
who need to absorb the main message in under 30 seconds. Keep bullets concise
(aim for one clear idea each) and lead with the most important finding.
```

The bad version produces compliant but lifeless output. The good version produces output that genuinely serves the reader, and adapts intelligently to different content.

### Keep It Lean

Remove instructions that aren't pulling their weight. Read the test transcripts — if the skill makes the agent spend time on steps that don't improve the output, cut them.

Signs of bloat:
- Steps the agent skips or rushes through
- Instructions that produce the same result whether followed or ignored
- Defensive instructions added "just in case" that never trigger

### Generalize, Don't Overfit

You're iterating on a few test cases, but the skill will be used on many different prompts. Rather than adding narrow fixes for specific test failures, understand the underlying pattern and address that.

Bad: `"When the input contains a CSV with columns named 'Revenue' and 'Cost', always calculate margin as (Revenue-Cost)/Revenue"`
Good: `"When performing financial calculations, identify the relevant columns by semantic meaning (revenue, cost, margin) rather than exact names, since naming conventions vary"`

### Bundle Repeated Work

If all test agents independently wrote similar helper scripts or took the same multi-step approach, that's a signal the skill should bundle that script in Tools/. Write it once so every future invocation doesn't reinvent the wheel.

---

## Step 4: Make the Changes

1. **Edit SKILL.md** — Update instructions, description, routing as needed
2. **Edit workflows** — Revise step-by-step instructions
3. **Add Tools/** — If repeated work was identified, create bundled scripts
4. **Validate structure** — Run through the ValidateSkill checklist mentally:
   - TitleCase naming preserved
   - Flat folder structure maintained
   - YAML frontmatter correct
   - Routing table matches files

---

## Step 5: Verify and Next Steps

After making changes:

- **If coming from TestSkill loop:** Return to TestSkill Step 3 to rerun tests with the improved skill. Use a new `iteration-[N+1]/` directory.
- **If standalone improvement:** Suggest running TestSkill to verify the improvements actually help.
- **If description changed:** Suggest running OptimizeDescription to verify trigger accuracy.

---

## Step 4a: Update Gotchas Section

**After every skill failure or improvement, update the `## Gotchas` section.** This is the highest-value section in any skill — it accumulates institutional knowledge about what goes wrong.

If the skill doesn't have a Gotchas section yet, add one after the workflow routing table.

Gotchas should capture:
- The specific failure that prompted this improvement
- API quirks discovered during testing
- Common mistakes Claude makes with this skill
- Edge cases that cause silent failures

### MERGE mode (automated skill-lesson landing)

When a lesson arrives from the inward-arrow capture loop (a low-rated turn attributed to this skill, approved by the principal at the Telegram gate), it lands in `## Gotchas` under **MERGE** semantics, applied deterministically by `LIFEOS/PULSE/lib/telegram-skill-lessons.ts:applySkillLesson`:

- **Merge, never blind-append.** Normalize the incoming bullet (strip stamp, lowercase, collapse to alphanumerics) and compare against existing Gotchas bullets. If it matches one, skip it — two runs that learn the same thing must not stack two near-identical bullets.
- **Create the section if absent**, at end of file.
- **Stamp provenance** on every landed bullet as an HTML comment: `<!-- skill-lesson: signal=… run=… model=… applied=… -->`. The stamp records the birth signal so the lesson can be traced and, if the signal is re-runnable, re-verified.
- **Human-gated only.** This applier writes SKILL.md exclusively from the approval handler. SKILL.md stays Tier D; the autonomous reviewer never reaches it. The human at the gate is the verifier of record.

MERGE mode is the narrow, automated path for a single approved lesson. Richer rewrites (rewording for clarity, consolidating related bullets, cutting bloat) remain the full agent-driven ImproveSkill flow above.

---

## Step 4b: BPE Audit

While improving, check each instruction against the bitter lesson test:

**"Would a smarter model make this instruction unnecessary?"**

- If YES → the instruction is compensating for model limitations. Consider removing it.
- If NO → the instruction provides knowledge Claude genuinely can't derive. Keep it.

Focus improvements on: accumulated failure knowledge (gotchas), tool wrappers (scripts), and workflow consistency — not on telling Claude how to think.

---

## Anti-Patterns to Avoid

- **Adding more MUSTs** — If something isn't working, adding louder instructions rarely helps. Reframe with reasoning instead.
- **Overfitting to test cases** — Fixes that only help the specific test prompts but break on novel inputs.
- **Defensive bloat** — Adding instructions for edge cases that will never occur in practice.
- **Changing structure instead of content** — If the skill's instructions are weak, reorganizing files won't fix that.
- **Stating the obvious** — Don't add instructions for things Claude already knows. Focus on what breaks its default patterns.
- **Model-limitation workarounds** — Don't add scaffolding that compensates for model weakness. It becomes dead weight as models improve.
