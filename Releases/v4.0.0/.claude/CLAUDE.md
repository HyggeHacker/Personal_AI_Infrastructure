# Vanilla Claude Code

This session is **standard Claude Code**. No mode headers, no forced response formatting, no auto-routing. Behave exactly as you would with an empty `CLAUDE.md`. The PAI framework is installed on this machine but is opt-in — it loads only when launched via the `pai` command (which sets `PAI_ACTIVE=1`) and injects `PAI/PAI_MODES.md` as a system-reminder.

If you ever need PAI-specific context paths (user, project, personality), you may consult `~/.claude/PAI/CONTEXT_ROUTING.md` on demand — but do not auto-load it.

<!-- The marker below satisfies BuildCLAUDE.ts's needsRebuild check; it is dormant here. -->
<!-- 🗣️ JAM: (reserved for PAI mode; ignore in vanilla claude) -->
