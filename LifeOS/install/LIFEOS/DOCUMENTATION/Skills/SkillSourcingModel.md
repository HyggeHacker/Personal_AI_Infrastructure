# Skill Sourcing & Distribution Model

> How a skill gets from an authoritative git source into `~/.claude/skills/` without drifting, and where every kind of customization lives. Companion to `SkillSystem.md` (which defines skill *structure*); this defines skill *sourcing*.

## The rule in one line

**Every live skill is a symlink into its authoritative git source. Live == source, so a live skill can never silently diverge from what is committed.**

```
~/.claude/skills/<Public>   →  ~/PAI/LifeOS/install/skills/<Public>     (the fork working tree)
~/.claude/skills/_<PRIVATE> →  ~/Projects/skills-private/_<PRIVATE>      (private git repo)
```

There are exactly two authoritative sources and no third. A skill that exists only as an uncommitted real dir under `~/.claude/skills/` is a bug, not a state.

## Why symlinks (and why the installer doesn't fight them)

The v6 installer lays skills down with `copyMissing` (`InstallEngine.ts`) — a recursive, `existsSync`-guarded copy that **never overwrites an existing target**. On a real-dir copy that is the drift engine: an old skill is preserved and a newer source version is never laid down.

Over a **correct skill-level symlink** `copyMissing` is a proven no-op: the destination resolves to the same inodes as the source, so every file "already exists" and 0 are copied — and nothing is written back through the link. (Verified empirically; see the OBSERVE evidence in the re-architecture ISA.) So symlinking live→source is compatible with the installer with no installer change.

Fresh installs are unaffected: a fresh box has no symlinks, and `DeployCore` still `copyMissing`s the staged release payload into real dirs. Symlinking is a **local dev-tree projection**, applied after install by the projection tool below.

## The one residual drift vector, and how it's caught

A NEW upstream skill (added by `git fetch upstream && merge`) has no symlink yet, so the next `DeployCore` copies it in as a **real dir**. That is the only way a real public dir can reappear. It is detectable and auto-correctable:

```bash
# project every public skill as a symlink (idempotent; backs up any real dir aside)
~/PAI/LifeOS/Tools/LinkSkills.sh

# report drift only — flags real public dirs, wrong-target symlinks, unlinked/orphan skills
~/PAI/LifeOS/Tools/LinkSkills.sh --check
```

`LinkSkills.sh` is the public-skill analogue of `skills-private/link.sh`. Both take a target dir argument, so the model is harness-agnostic (`--target ~/.cursor/skills`, etc.).

## Upstream updates flow with no per-skill work

```bash
git -C ~/PAI fetch upstream && git -C ~/PAI merge upstream/main   # or the LifeOS upgrade path
~/PAI/LifeOS/Tools/LinkSkills.sh                                   # only if new skills were added
```

Because live is a symlink into the fork working tree, a merged change is live the instant it lands — no re-copy, no per-skill step. Only brand-new skills need a re-link.

## Where does a customization go? (one home per type)

| Kind of customization | Home | Mechanism |
|---|---|---|
| **Small per-skill tweak** (aesthetic, preference, local config) that must NOT ship publicly | `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<Skill>/` overlay | Runtime-read by the skill's `## Customization` block; `LIFEOS/USER` is a private symlink, never in the public fork. **Never edit the skill in place for this.** |
| **Substantial custom workflow/tool on a public skill** (shareable, generic) | The fork: `~/PAI/LifeOS/install/skills/<Skill>/` | Edit the live symlink (the edit lands in the fork working tree), then `git -C ~/PAI commit && push`. Shows up in `git -C ~/PAI status`. |
| **Fully-private skill** (identity/customer/tool-specific) | `~/Projects/skills-private/_<SKILL>/` | Commit there; `link.sh` symlinks it into `~/.claude/skills/`. |

**No silent in-place edits.** Editing a symlinked public skill IS editing the fork (that is the point) — so it must be committed to the fork, or it is not "saved," it is just uncommitted working-tree state. If a tweak should stay private, it goes in the overlay, not in the skill body.

## Known properties & trade-offs (by design)

- **Live is coupled to the fork's checked-out branch.** Branch switches, rebases, and mid-edit WIP in `~/PAI` are instantly live. That is the intended trade — immediacy over test-then-deploy isolation — for a personal setup. If you ever want release pinning, `git worktree` gives it without changing the model.
- **Runtime writes land in the fork working tree.** A skill that writes into its own dir at runtime (e.g. `Upgrade/Logs/`, a self-refreshing `sources.json`) now dirties `~/PAI`. Pure runtime state is `.gitignore`d; anything else is surfaced by `LinkSkills.sh --check` (the `DIRTY source tree` line) so it is triaged, not blind-committed. `git clean -fd` / `git stash` in the fork now mutate live skills — run them deliberately.
- **The installer no-op is verified against the current harness, not guaranteed forever.** A future Claude Code that stops following skill symlinks, or a future installer that writes *through* a symlink, would break the model. `--check` flags write-through dirt and dangling links as an early detector.

## Verification

- `ls -la ~/.claude/skills/` — every public entry and every `_*` entry is a symlink; no real skill dirs.
- `LinkSkills.sh --check` — exits 0 (drift/dangling/orphan all zero; `dirty` is advisory).
- `bun ~/PAI/LifeOS/Tools/DeployCore.ts` (dry-run) — 0 would-copy for existing skills; `copyMissing` over the live symlinks copies 0 with no write-through.
