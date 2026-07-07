#!/usr/bin/env bash
# LinkSkills.sh — project every PUBLIC skill from the fork source into a harness
# skills dir as a SYMLINK, so live == source and drift is structurally impossible.
# The public-skill analogue of skills-private/link.sh (which handles _* private skills).
#
# Together the two tools give one authoritative source per skill:
#   public  → ~/PAI/LifeOS/install/skills/<Skill>   (this tool)
#   private → ~/Projects/skills-private/_<SKILL>     (skills-private/link.sh)
#
# copyMissing (the installer) no-ops over a correct symlink, so re-running the
# installer never clobbers these links. The ONE residual drift vector is a NEW
# upstream skill copied in as a real dir on the next DeployCore — `--check` finds
# it and a plain run re-projects it.
#
# Usage:
#   ./LinkSkills.sh [--target <skills_dir>] [--source <install/skills>] [--check]
#     (default target: ~/.claude/skills ; harness-agnostic — point at ~/.cursor/skills etc.)
#     --check : report drift only, mutate nothing (exit 1 if any drift)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/../install/skills"
TARGET="$HOME/.claude/skills"
CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --check)  CHECK=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SOURCE="$(cd "$SOURCE" && pwd)"
[ -d "$TARGET" ] || mkdir -p "$TARGET"

linked=0 already=0 relinked=0 drift=0 unlinked=0 orphan=0 dangling=0 dirty=0
# One backup dir per run, decided up front in the PARENT shell (never inside a
# $(...) command substitution — that runs in a subshell and would mint a fresh
# dir on every call). Created lazily on first displacement via ensure_backup.
BACKUP="${TARGET%/}-prelink-$(date +%s)"
backup_made=0
ensure_backup() { [ "$backup_made" = 1 ] || { mkdir -p "$BACKUP"; backup_made=1; }; }

# 1) Every source skill (dirs only; skip the CLAUDE.md file and any stray _*).
for dir in "$SOURCE"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "${dir%/}")"
  case "$name" in _*) continue ;; esac        # private skills are skills-private's job
  src="${dir%/}"
  dest="$TARGET/$name"

  if [ -L "$dest" ]; then
    cur="$(readlink "$dest")"
    if [ "$cur" = "$src" ]; then already=$((already+1)); continue; fi
    # symlink to the wrong place
    if [ "$CHECK" = 1 ]; then echo "DRIFT wrong-target symlink: $name -> $cur (want $src)"; drift=$((drift+1)); continue; fi
    rm -f "$dest"; ln -s "$src" "$dest"; echo "relinked $name (was -> $cur)"; relinked=$((relinked+1)); continue
  fi

  if [ -e "$dest" ]; then
    # a REAL dir/file shadows the source — this is drift
    if [ "$CHECK" = 1 ]; then echo "DRIFT real dir (not symlink): $name"; drift=$((drift+1)); continue; fi
    ensure_backup; mv "$dest" "$BACKUP/$name"
    ln -s "$src" "$dest"; echo "linked $name (real dir backed up -> $BACKUP/$name)"; linked=$((linked+1)); continue
  fi

  # absent
  if [ "$CHECK" = 1 ]; then echo "MISSING not linked: $name"; unlinked=$((unlinked+1)); continue; fi
  ln -s "$src" "$dest"; echo "linked $name"; linked=$((linked+1))
done

# 2) Target-side report: orphan real dirs (stale skills) + DANGLING symlinks
#    (target points nowhere — skill deleted from the source, or ~/PAI moved).
for entry in "$TARGET"/*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name="$(basename "$entry")"
  case "$name" in _*) continue ;; esac
  if [ -L "$entry" ]; then
    if [ ! -e "$entry" ]; then                 # broken symlink (target missing)
      echo "DANGLING symlink: $name -> $(readlink "$entry") (target gone)"; dangling=$((dangling+1))
    fi
    continue
  fi
  [ -d "$entry" ] || continue
  [ -d "$SOURCE/$name" ] && continue            # real dir WITH a source → drift, handled above
  echo "ORPHAN real public dir with no source: $name (stale? resolve or remove)"; orphan=$((orphan+1))
done

# 3) Write-through / runtime-write detection: if the SOURCE is a git repo, a dirty
#    working tree under the skills dir means either a runtime write landed through a
#    symlink or an uncommitted edit — surface it so it is triaged, not silent.
if git -C "$SOURCE" rev-parse --git-dir >/dev/null 2>&1; then
  rel="$(git -C "$SOURCE" rev-parse --show-prefix 2>/dev/null)"
  dirty=$(git -C "$SOURCE" status --porcelain -- "." 2>/dev/null | grep -c . || true)
  if [ "${dirty:-0}" -gt 0 ] && [ "$CHECK" = 1 ]; then
    echo "DIRTY source tree: $dirty uncommitted path(s) under ${rel:-source} (runtime write-through or unpushed edits — triage before it drifts)"
  fi
fi

echo "----"
if [ "$CHECK" = 1 ]; then
  echo "LinkSkills --check: drift=$drift dangling=$dangling unlinked=$unlinked orphan=$orphan dirty=$dirty already=$already  ($SOURCE -> $TARGET)"
  [ "$drift" -eq 0 ] && [ "$dangling" -eq 0 ] && [ "$unlinked" -eq 0 ] && [ "$orphan" -eq 0 ] && { echo "OK: no drift (dirty=$dirty is advisory)"; exit 0; }
  echo "DRIFT DETECTED"; exit 1
else
  echo "LinkSkills: linked=$linked relinked=$relinked already-current=$already orphan=$orphan  ($SOURCE -> $TARGET)"
  [ "$backup_made" = 1 ] && echo "displaced real dirs backed up under: $BACKUP"
fi
