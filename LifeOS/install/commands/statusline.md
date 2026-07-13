---
description: Show and toggle which rows the LifeOS statusline renders
argument-hint: "[<row> | off <row> | on <row> | reset | all-on | all-off]"
---

Control which rows the LifeOS statusline shows. Each row is independently toggleable; the statusline reflects changes on its next tick (~1s).

Run exactly this and show me its output verbatim (it's a rendered control panel), nothing else:

```bash
bun "$HOME/.claude/LIFEOS/TOOLS/StatuslineRows.ts" $ARGUMENTS
```

Notes:
- No argument → lists every row with its ON/OFF state.
- `/statusline quote` toggles that row; `/statusline off files` / `/statusline on state` force a state.
- `/statusline reset` restores the default (D) layout; `/statusline all-on` / `all-off` flip everything.
- Rows: header, state, mode, memory_health, env, agents, context, files, pwd, memory, quote, use.
