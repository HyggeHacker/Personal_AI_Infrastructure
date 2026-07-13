# Sync Private Skills

> ⚠️ **DEPRECATED 2026-07-06 — do not run.** Superseded by `~/Projects/skills-private`,
> a plain private git repo consumed via `link.sh` symlinks (no PAI machinery). The
> live `~/.claude/skills/_*` are now symlinks INTO that repo, so backup/distribute is
> just git: `cd ~/Projects/skills-private && git add -A && git commit && git push`.
> Running this skill pushes to the old private-repo layout and will DIVERGE from
> the current one. Kept only for reference / one-off public export via `export-portable.sh`.
> See `LIFEOS/DOCUMENTATION/Skills/SkillSourcingModel.md` for the current model.

Syncs local custom skills (`_*` prefixed) from `~/.claude/skills/` to the `<your-org>/<your-private-skills-repo>` GitHub repo.

## When to Use

- After editing any custom skill locally and wanting to back it up to git
- "sync private skills", "publish skill changes", "push skill updates", "back up skills"

## Skill-to-Repo Mapping

| Local Skill | Repo Directory | Notes |
|---|---|---|
| `_EXAMPLE_SKILL_A` | `my-skill-a` | First private skill |
| `_EXAMPLE_SKILL_B` | `my-skill-b` | Second private skill |

**Adding new skills**: When a new `_*` skill is created locally, add a row to this table and create the corresponding repo directory structure: `pai-{name}-skill/src/skills/{SKILL_NAME}/`.

## Customization

**Before executing, also load any additional mappings from:**
`~/.claude/LIFEOS/USER/SKILLCUSTOMIZATIONS/SyncPrivateSkills/PREFERENCES.md`

If that file exists, treat any `Local Skill` → `Repo Directory` rows there as **additional** entries to process alongside the table above. This is the integration point for skills that should not appear in the public fork (e.g. tool-specific skills wrapping commercial products). LIFEOS/USER is chezmoi-encrypted and stays private.

## Workflow

### Step 1: Clone and Detect Changes

```bash
# Clone to /tmp (fresh every time — avoids stale state)
cd /tmp && rm -rf private-skills && gh repo clone <your-org>/<your-private-skills-repo> private-skills

# For each mapped skill, rsync local → repo and check for diffs
```

For each skill in the mapping table:
1. Determine local path: `~/.claude/skills/{SKILL_NAME}/`
2. Determine repo path: `/tmp/private-skills/{REPO_DIR}/src/skills/{SKILL_NAME}/`
3. If repo path doesn't exist, this is a **new skill** — create directory structure
4. Copy: `rsync -av --delete --exclude='outputs/' --exclude='targets/' --exclude='engagements/' --exclude='.venv/' --exclude='__pycache__/' --exclude='node_modules/' --exclude='.env' --exclude='.token_cache' {local}/ {repo}/`
   (mirror exactly, removing files deleted locally; excludes prevent engagement-runtime artifacts from leaking into the skill backup repo)
5. Run `git diff --stat` to see what changed

### Step 2: Preview Changes

Show the user:
- Which skills have changes (with file counts and line counts)
- Which skills are unchanged
- Any new skills being added for the first time

```bash
cd /tmp/private-skills && git diff --stat
# Also check for untracked files (new skills)
git status --short
```

**If no changes detected**: Report "All skills are in sync" and stop.

### Step 3: Commit and Push

For each skill with changes, stage its files:

```bash
cd /tmp/private-skills
git add {repo_dir}/
```

Commit with a descriptive message derived from the changes:
- If single skill changed: `feat({skill-name}): {description of changes}`
- If multiple skills changed: `feat(skills): sync {N} skills — {brief summary}`

Push to main:
```bash
git push origin main
```

### Step 4: Cleanup

```bash
rm -rf /tmp/private-skills
```

Report: which skills were synced, commit hash, any issues.

## Single Skill Mode

When the user specifies a single skill (e.g., "sync external pentest skill"), only process that one skill. Look up the mapping, sync just that directory, and commit with a skill-specific message.

## Flags and Options

| Option | Behavior |
|---|---|
| `--dry-run` or "show me what changed" | Steps 1-2 only, no commit/push |
| `--all` or "sync all skills" (default) | Process every mapped skill |
| Single skill name | Process only that skill |

## Error Handling

- **gh not authenticated**: Prompt user to run `gh auth login`
- **Skill not in mapping**: Warn and ask if they want to add it
- **Push fails**: Show error, suggest `git pull --rebase` if behind
- **No changes**: Report clean state, don't create empty commit
