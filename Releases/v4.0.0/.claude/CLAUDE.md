# Claude Code default behavior

If a system-reminder titled **"PAI Modes — Response Formatting Rules"** appears in this conversation, those rules supersede everything below — follow them and disregard the rest of this file. They will only appear when this session was launched via the `pai` command (which sets `PAI_ACTIVE=1` and triggers `LoadContext.hook.ts` to inject `PAI/PAI_MODES.md`).

Otherwise, behave as **standard Claude Code**: no mode headers, no forced response formatting, no auto-routing. The PAI 4.0.3 framework is installed on this machine but is opt-in.

If you ever need PAI-specific context paths (user, project, personality), consult `~/.claude/PAI/CONTEXT_ROUTING.md` on demand — do not auto-load it.

<!-- The marker below satisfies BuildCLAUDE.ts's needsRebuild check; it is dormant outside PAI mode. -->
<!-- 🗣️ JAM: dormant marker -->
