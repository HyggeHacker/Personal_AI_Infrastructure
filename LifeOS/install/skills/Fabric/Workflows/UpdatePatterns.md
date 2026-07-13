# UpdatePatterns Workflow

Update Fabric patterns from upstream under the currency contract (`LIFEOS/DOCUMENTATION/Currency/CurrencySystem.md`). The old flow blind-mirrored upstream over local with `rsync -av --delete`, which silently destroys any local-only pattern and is verified by a file count that cannot even catch a same-count swap. This flow previews the set difference first, gates the destructive delete on review, and stamps the synced set so staleness is trackable.

---

## Prerequisites

**Fabric CLI installed**, to pull the upstream patterns:
```bash
go install github.com/danielmiessler/fabric@latest
```

---

## Workflow Steps

### Step 1: Voice notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Updating Fabric patterns from upstream repository"}' \
  > /dev/null 2>&1 &
```

### Step 2: Pull upstream

```bash
fabric -U   # updates ~/.config/fabric/patterns/
```

### Step 3: Preview the set difference (read-only)

```bash
bun ~/.claude/skills/Fabric/Tools/PatternCurrency.ts preview
```

This lists patterns the sync would GAIN and, crucially, the local-only patterns a `--delete` would DESTROY. It changes nothing.

### Step 4: Delete-guard (mandatory before the destructive sync)

If the preview reports any "would DELETE" patterns, STOP. Those patterns exist locally but not upstream, so a blind mirror would wipe them. They are usually local customizations. Before proceeding, either:
- back them up (copy them out of `Patterns/` to a safe location), or
- confirm they are genuinely disposable.

Only continue when the would-delete set is empty or you have deliberately acknowledged each entry. Step 5 enforces this mechanically: the sync will not run while local-only patterns would be deleted unless you pass `--allow-delete`.

### Step 5: Sync (mechanically gated)

The `guard` command exits non-zero when local-only patterns would be destroyed, so the sync cannot blind-delete. If the preview was clean the guard passes and the sync runs. Otherwise back the patterns up (then the guard passes) or acknowledge the deletions explicitly.

```bash
# Sync only if no local-only pattern would be lost:
bun ~/.claude/skills/Fabric/Tools/PatternCurrency.ts guard && \
  rsync -av --delete ~/.config/fabric/patterns/ ~/.claude/skills/Fabric/Patterns/

# To proceed while deliberately deleting the local-only patterns the preview listed:
bun ~/.claude/skills/Fabric/Tools/PatternCurrency.ts guard --allow-delete && \
  rsync -av --delete ~/.config/fabric/patterns/ ~/.claude/skills/Fabric/Patterns/
```

### Step 6: Stamp the synced set

```bash
bun ~/.claude/skills/Fabric/Tools/PatternCurrency.ts stamp
bun ~/.claude/skills/Fabric/Tools/PatternCurrency.ts status   # confirm the recorded set + hash
```

The stamp records the pattern-set hash and count, so the next preview has a baseline and a same-count swap is no longer invisible.

### Step 7: Verify key patterns

```bash
for pattern in extract_wisdom summarize create_threat_model analyze_claims; do
  if [ -d ~/.claude/skills/Fabric/Patterns/$pattern ]; then echo "✓ $pattern"; else echo "✗ $pattern MISSING"; fi
done
```

---

## State and mechanism

- Freshness state: `skills/Fabric/State/currency-state.json` (last-synced pattern-set hash, count, and timestamp).
- The set-drift, stamp, and hashing plumbing is the shared helper `LIFEOS/TOOLS/Currency.ts`; `PatternCurrency.ts` adds only the local and upstream corpus observation and the preview. Fabric is a class-C (data corpus) consumer: the tracked set is the live `Patterns/` directory, not a static registry, so there is no `sources.json` here.

---

## Alternative: manual git update

If the fabric CLI is unavailable, pull the repo directly, then run the SAME preview and guard before syncing:

```bash
cd /tmp && { [ -d fabric ] && (cd fabric && git pull) || git clone https://github.com/danielmiessler/fabric.git; }
# Preview against the cloned patterns dir before any --delete, then sync deliberately.
rsync -av --delete /tmp/fabric/patterns/ ~/.claude/skills/Fabric/Patterns/
cd /tmp && rm -rf fabric
```

Never run the `--delete` sync without previewing the would-delete set first.

---

## Output

Report to user:
- Patterns gained and patterns that would be deleted (from the preview).
- Whether any local-only patterns were protected before syncing.
- Previous and new pattern-set hash and count (from the stamp).
