# Sync Private Skills

Syncs local custom skills (`_*` prefixed) from `~/.claude/skills/` to the `HyggeHacker/pai-private` GitHub repo.

## When to Use

- After editing any custom skill locally and wanting to back it up to git
- "sync private skills", "publish skill changes", "push skill updates", "back up skills"

## Skill-to-Repo Mapping

| Local Skill | Repo Directory | Notes |
|---|---|---|
| `_INTERNAL_PENTEST` | `pai-internal-pentest-skill` | Internal pentest orchestration |
| `_EXTERNAL_PENTEST` | `pai-external-pentest-skill` | External pentest with BBOT |
| `_WEBAPP_PENTEST` | `pai-webapp-pentest-skill` | Web app pentest OWASP WSTG |
| `_AZURE_PENTEST` | `pai-azure-pentest-skill` | Azure / Entra ID / M365 assessment (consolidated 2026-04-28: absorbed former `_AZURE_ANALYSIS` and `_AZURE_COMPLIANCE`) |
| `_PENTEST_FOUNDATION` | `pai-pentest-foundation-skill` | Shared pentest architecture |
| `_PLEXTRAC_IMPORT` | `pai-plextrac-import-skill` | PlexTrac finding import |
| `_THREAT_MODEL_FOUNDATION` | `pai-threat-model-foundation-skill` | Shared threat-modeling architecture |
| `_AI_ASSESSMENT` | `pai-ai-assessment-skill` | AI / agentic-platform security assessment |

**Adding new skills**: When a new `_*` skill is created locally, add a row to this table and create the corresponding repo directory structure: `pai-{name}-skill/src/skills/{SKILL_NAME}/`.

## Customization

**Before executing, also load any additional mappings from:**
`~/.claude/LIFEOS/USER/SKILLCUSTOMIZATIONS/SyncPrivateSkills/PREFERENCES.md`

If that file exists, treat any `Local Skill` → `Repo Directory` rows there as **additional** entries to process alongside the table above. This is the integration point for skills that should not appear in the public fork (e.g. tool-specific skills wrapping commercial products — currently `_NESSUS` → `pai-nessus-skill` and `_RUNZERO` → `pai-runzero-skill`). LIFEOS/USER is chezmoi-encrypted and stays private.

## Workflow

### Step 1: Clone and Detect Changes

```bash
# Clone to /tmp (fresh every time — avoids stale state)
cd /tmp && rm -rf pai-private && gh repo clone HyggeHacker/pai-private

# For each mapped skill, rsync local → repo and check for diffs
```

For each skill in the mapping table:
1. Determine local path: `~/.claude/skills/{SKILL_NAME}/`
2. Determine repo path: `/tmp/pai-private/{REPO_DIR}/src/skills/{SKILL_NAME}/`
3. If repo path doesn't exist, this is a **new skill** — create directory structure
4. Copy: `rsync -av --delete --exclude='outputs/' --exclude='targets/' --exclude='engagements/' --exclude='.env' --exclude='.token_cache' {local}/ {repo}/`
   (mirror exactly, removing files deleted locally; excludes prevent engagement-runtime artifacts from leaking into the skill backup repo)
5. Run `git diff --stat` to see what changed

### Step 2: Preview Changes

Show the user:
- Which skills have changes (with file counts and line counts)
- Which skills are unchanged
- Any new skills being added for the first time

```bash
cd /tmp/pai-private && git diff --stat
# Also check for untracked files (new skills)
git status --short
```

**If no changes detected**: Report "All skills are in sync" and stop.

### Step 3: Commit and Push

For each skill with changes, stage its files:

```bash
cd /tmp/pai-private
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
rm -rf /tmp/pai-private
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
