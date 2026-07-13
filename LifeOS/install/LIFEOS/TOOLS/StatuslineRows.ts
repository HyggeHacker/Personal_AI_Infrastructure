#!/usr/bin/env bun
// StatuslineRows.ts — control which rows the LifeOS statusline renders.
//
// Single source of truth is a bash-sourceable conf (key=0|1 per line) at
// USER/CONFIG/statusline-rows.conf. LIFEOS_StatusLine.sh sources it and gates
// each row on its key; this CLI lists/toggles the keys. Keeping the schema here
// (ROWS) and the conf bash-sourceable means one definition drives both the
// render and the control surface.
//
// Usage:
//   bun StatuslineRows.ts               # list all rows + state
//   bun StatuslineRows.ts <row>         # toggle one row
//   bun StatuslineRows.ts on <row>      # force on
//   bun StatuslineRows.ts off <row>     # force off
//   bun StatuslineRows.ts reset         # restore D defaults
//   bun StatuslineRows.ts all-on|all-off

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONF = join(homedir(), ".claude/LIFEOS/USER/CONFIG/statusline-rows.conf");

// key, label, default (D layout), one-line description
const ROWS: { key: string; label: string; def: 0 | 1; desc: string }[] = [
  { key: "header",        label: "Header",         def: 1, desc: "brand · location · time · weather" },
  { key: "state",         label: "STATE",          def: 0, desc: "TELOS dimension meters (needs /interview)" },
  { key: "mode",          label: "Mode ladder",    def: 1, desc: "⚙️ mode + effort ladder" },
  { key: "memory_health", label: "Memory health",  def: 0, desc: "🧠 autonomic review-cadence status" },
  { key: "env",           label: "ENV",            def: 1, desc: "◈ harness · model · versions" },
  { key: "agents",        label: "Agents",         def: 1, desc: "🤖 router agent lineup" },
  { key: "context",       label: "Context bar",    def: 1, desc: "◉ context-window gauge" },
  { key: "files",         label: "Loaded files",   def: 0, desc: "SKILLS + loaded-file context attribution" },
  { key: "pwd",           label: "PWD",            def: 1, desc: "◈ working directory" },
  { key: "memory",        label: "Memory counters",def: 1, desc: "◎ work · ratings · sessions · research" },
  { key: "quote",         label: "Quote",          def: 1, desc: "✦ rotating aphorism" },
  { key: "use",           label: "Usage",          def: 1, desc: "▰ 5H / week rate-limit meters" },
];
const KEYS = new Set(ROWS.map((r) => r.key));

type State = Record<string, 0 | 1>;

function load(): State {
  const s: State = {};
  for (const r of ROWS) s[r.key] = r.def;
  if (existsSync(CONF)) {
    for (const line of readFileSync(CONF, "utf8").split("\n")) {
      const m = line.match(/^\s*SLR_([a-z_]+)\s*=\s*([01])/);
      if (m && KEYS.has(m[1])) s[m[1]] = Number(m[2]) as 0 | 1;
    }
  }
  return s;
}

function save(s: State): void {
  mkdirSync(dirname(CONF), { recursive: true });
  const body = [
    "# LifeOS statusline row toggles — 1=show, 0=hide.",
    "# Managed by `/statusline` (LIFEOS/TOOLS/StatuslineRows.ts). Bash-sourceable (SLR_* vars).",
    ...ROWS.map((r) => `SLR_${r.key}=${s[r.key]}  # ${r.label}: ${r.desc}`),
    "",
  ].join("\n");
  writeFileSync(CONF, body);
}

function list(s: State): void {
  console.log("LifeOS statusline rows:\n");
  for (const r of ROWS) {
    const on = s[r.key] === 1;
    const dot = on ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
    const tag = on ? "\x1b[32mON \x1b[0m" : "\x1b[90mOFF\x1b[0m";
    console.log(`  ${dot} ${tag}  ${r.key.padEnd(14)} ${r.label.padEnd(16)} \x1b[90m${r.desc}\x1b[0m`);
  }
  console.log("\nToggle:  /statusline <row>   ·   /statusline off <row>   ·   /statusline reset");
}

const args = process.argv.slice(2).filter(Boolean);
const s = load();

if (args.length === 0 || args[0] === "list") {
  list(s);
} else if (args[0] === "reset") {
  for (const r of ROWS) s[r.key] = r.def;
  save(s);
  console.log("Reset to default (D) layout.");
  list(s);
} else if (args[0] === "all-on" || args[0] === "all-off") {
  const v = args[0] === "all-on" ? 1 : 0;
  for (const r of ROWS) s[r.key] = v as 0 | 1;
  save(s);
  list(s);
} else {
  // forms: "<row>" (toggle) | "on <row>" | "off <row>" | "<row> on|off"
  let action = "toggle";
  let key = "";
  if (args[0] === "on" || args[0] === "off") { action = args[0]; key = args[1] ?? ""; }
  else if (args[1] === "on" || args[1] === "off") { action = args[1]; key = args[0]; }
  else { key = args[0]; }

  if (!KEYS.has(key)) {
    console.error(`Unknown row "${key}". Known rows: ${[...KEYS].join(", ")}`);
    process.exit(1);
  }
  s[key] = action === "toggle" ? ((s[key] ^ 1) as 0 | 1) : ((action === "on" ? 1 : 0) as 0 | 1);
  save(s);
  console.log(`${key} → ${s[key] === 1 ? "\x1b[32mON\x1b[0m" : "\x1b[90mOFF\x1b[0m"}  (statusline updates within ~1s)`);
}
