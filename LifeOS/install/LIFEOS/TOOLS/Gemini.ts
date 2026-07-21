#!/usr/bin/env bun
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

/**
 * Gemini.ts - Google Gemini search client (Generative Language API, direct)
 *
 * Direct-to-Google engine for the GeminiResearcher agent. By default enables
 * Google Search grounding (the researcher's edge) so Gemini answers against the
 * live web with citations, the same shape Grok.ts gives for web + X. Uses the
 * plain generativelanguage REST API with the x-goog-api-key header — no SDK, no
 * OpenRouter broker, one GOOGLE_API_KEY covers this and nano-banana-pro.
 *
 * Usage:
 *   bun ~/.claude/LIFEOS/TOOLS/Gemini.ts "<query>"                       # grounded, user-only
 *   bun ~/.claude/LIFEOS/TOOLS/Gemini.ts "<system>" "<query>"            # system + user
 *   bun ~/.claude/LIFEOS/TOOLS/Gemini.ts --no-search "<system>" "<q>"    # no web grounding
 *   bun ~/.claude/LIFEOS/TOOLS/Gemini.ts --level high "<system>" "<q>"   # thinking hint
 *   bun ~/.claude/LIFEOS/TOOLS/Gemini.ts --model gemini-3.1-pro-preview "<q>"
 *   bun ~/.claude/LIFEOS/TOOLS/Gemini.ts --json "<q>"
 *
 * Options:
 *   --model <id>      Model id (default: gemini-3.1-pro-preview)
 *   --level <l>       low | medium | high — maps to temperature + output budget (default: medium)
 *   --no-search       Disable Google Search grounding (pure model knowledge)
 *   --max-tokens <n>  Cap output tokens (default: level-derived)
 *   --json            Emit raw {content, citations, usage} JSON
 *
 * Positional args: one = user prompt; two = system prompt, then user prompt.
 *
 * Environment:
 *   GOOGLE_API_KEY (or GEMINI_API_KEY)   Google Generative Language key (required)
 *
 * Exit codes: 0 ok, 1 error (missing key, API failure, no output)
 *
 * @author LifeOS System
 * @version 1.0.0
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

const colors = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
}

// Load environment — mirrors LIFEOS/TOOLS/Grok.ts convention
function loadEnv(): Record<string, string> {
  const envPath = process.env.LIFEOS_CONFIG_DIR
    ? join(process.env.LIFEOS_CONFIG_DIR, '.env')
    : join(homedir(), '.claude', '.env')
  const env: Record<string, string> = {}
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/)
      if (match) env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // ignore — fall back to process.env
  }
  return env
}

const env = loadEnv()
const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GEMINI_API_KEY
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

interface Parsed { content: string; citations: string[]; usage: any }

const LEVELS: Record<string, { temperature: number; maxTokens: number }> = {
  low: { temperature: 0.2, maxTokens: 2048 },
  medium: { temperature: 0.5, maxTokens: 4096 },
  high: { temperature: 0.7, maxTokens: 8192 },
}

function parseArgs(argv: string[]) {
  const opts = { model: 'gemini-3.1-pro-preview', level: 'medium', search: true, json: false, maxTokens: 0 }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-search') opts.search = false
    else if (a === '--json') opts.json = true
    else if (a === '--model') opts.model = argv[++i]
    else if (a === '--level') opts.level = argv[++i]
    else if (a === '--max-tokens') opts.maxTokens = parseInt(argv[++i], 10) || 0
    else rest.push(a)
  }
  // one positional = user; two = system, user
  let system = ''
  let query = ''
  if (rest.length >= 2) { system = rest[0]; query = rest.slice(1).join(' ').trim() }
  else { query = rest.join(' ').trim() }
  return { opts, system, query }
}

async function gemini(system: string, query: string, opts: ReturnType<typeof parseArgs>['opts']): Promise<Parsed> {
  const level = LEVELS[opts.level] ?? LEVELS.medium
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: query }] }],
    generationConfig: {
      temperature: level.temperature,
      maxOutputTokens: opts.maxTokens > 0 ? opts.maxTokens : level.maxTokens,
    },
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (opts.search) body.tools = [{ google_search: {} }]

  const res = await fetch(`${API_BASE}/${opts.model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': API_KEY as string, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const data = await res.json() as any
  if (!res.ok || data.error) {
    throw new Error(typeof data.error === 'string' ? data.error : (data.error?.message || `HTTP ${res.status}`))
  }

  const cand = data.candidates?.[0]
  let content = ''
  for (const p of cand?.content?.parts ?? []) if (p.text) content += p.text

  const citations = new Set<string>()
  for (const chunk of cand?.groundingMetadata?.groundingChunks ?? []) {
    if (chunk?.web?.uri) citations.add(chunk.web.uri)
  }

  return { content: content.trim(), citations: Array.from(citations), usage: data.usageMetadata ?? {} }
}

async function main() {
  const { opts, system, query } = parseArgs(process.argv.slice(2))

  if (!API_KEY) {
    console.error(`${colors.red}Error: GOOGLE_API_KEY (or GEMINI_API_KEY) not set in ~/.claude/.env${colors.reset}`)
    process.exit(1)
  }
  if (!query) {
    console.error(`${colors.red}Error: no query provided${colors.reset}`)
    console.error(`Usage: bun ~/.claude/LIFEOS/TOOLS/Gemini.ts [--no-search] [--level low|medium|high] [--model <id>] [--json] "<system>" "<query>"`)
    process.exit(1)
  }

  let result: Parsed
  try {
    result = await gemini(system, query, opts)
  } catch (e: any) {
    console.error(`${colors.red}Google API error: ${e.message}${colors.reset}`)
    process.exit(1)
  }

  if (!result.content) {
    console.error(`${colors.red}Error: empty response from Gemini${colors.reset}`)
    process.exit(1)
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(result.content)
  if (result.citations.length) {
    console.log(`\n${colors.dim}Sources:${colors.reset}`)
    result.citations.forEach((u, i) => console.log(`${colors.dim}[${i + 1}]${colors.reset} ${u}`))
  }
  const u = result.usage
  if (u?.totalTokenCount) {
    console.error(`${colors.dim}(${opts.model}, grounding: ${opts.search ? 'on' : 'off'}, ${u.totalTokenCount} tokens)${colors.reset}`)
  }
}

main()
