# The Currency Contract

How a LifeOS skill keeps its external facts current. This is the written convention that the scattered Update and Refresh workflows should standardize on, and the shared helper `LIFEOS/TOOLS/Currency.ts` is its mechanism. This file is the operative contract.

Note the boundary with `LIFEOS/DOCUMENTATION/Freshness/FreshnessSystem.md`. That governs the `pai-freshness-v1` frontmatter convention, namely how a document records when it was last reviewed. This contract governs a different thing, namely how an external fact baked into a skill (a framework version, a taxonomy, a research feed, a price, a piece of threat intel) is kept re-verifiable and current. The two are adjacent and neither replaces the other.

## The one property

Currency is not a scheduled rewrite of files. Currency is a property enforced at the point where a fact is used. An external fact is current if it carries an anchor that can be re-verified against a primary source, and if that re-verification actually happens before the fact is relied upon. Everything below is machinery in service of that property.

The corollary is the rule the whole system turns on. Treat an unstamped fact as reconstructed until re-fetched. A version or a count carried in prose without a stamp is a memory of a source, not a citation of one, and it may not harden into an asserted fact until it has been re-read from the primary source and stamped.

## What the skill owns, what the helper owns

The dividing line is deliberate. Consolidate the plumbing, distribute the judgment. A shared module that also decided what counts as changed would be one bad edit poisoning every skill at once, so the helper never makes that call.

The skill owns the epistemics: its own `sources.json`, the prompt it fetches each source with, and the judgment of whether an observed change touches the method rather than just a fact. The helper owns the plumbing: formatting and parsing the stamp, diffing an observed value against stored state, classifying a change into a landing tier once the skill has supplied its judgment, prepend-and-prune of a digest, the PROPOSED UPDATE block, registry validation, and structural-count parsing. The helper performs no network fetch and reads no wall clock except through an injectable parameter, so it stays offline and testable.

## The source registry schema

Each skill keeps a `Data/sources.json` with a `sources` array. Every source carries these required fields.

- `id`, a stable unique slug.
- `name`, the human name.
- `url`, the canonical primary source.
- `type`, a short kind label (taxonomy, framework, standard, blog, database, reference).
- `track`, one of exactly `version` or `posts`. A `version` source is a framework or taxonomy whose release version and changelog matter. A `posts` source is a research feed whose new items matter.
- `method`, how it is fetched (webfetch, github-releases, and so on).
- `categories`, an array of category slugs.
- `why`, one sentence on what the source anchors and why it is trusted.

A `version` source additionally requires `current_version`, the value last seen. Two optional fields carry the failure-mode handling below: `search_fallback: true` and, on a `posts` source, a `filter` string. Run `bun LIFEOS/TOOLS/Currency.ts validate <path>` to check a registry against this schema; a skill's `Data/sources.json` validates clean against it and is the worked reference.

## The version stamp

Every external fact in skill content carries one consistent, grep-compatible line.

`**Version:** <value> **(as of YYYY-MM-DD)**`

The helper is the only thing that should write or rewrite it: `formatStamp(value, date)` produces it, `parseStamp(line)` reads it back, `findStamps(text)` locates every stamp in a document, and `updateStampInText(text, matchValue, newValue, date)` rewrites one in place while leaving the others untouched. Keep the format identical everywhere so a single refresh pass can walk every stamped file at once. This contract is the canonical definition of the format; any other file that mentions it, including `FrameworkAnchoring.md`, defers here.

## The structural-count rule

A fast-moving matrix should be pinned by structural counts, not by a floating vendor version tag that moves under you. MITRE ATLAS, for example, is anchored as its tactic, technique, sub-technique, and case-study counts rather than a blog version string. The helper's `parseCounts(s)` turns a line like "16 tactics / 84 techniques / 56 sub-techniques" into the pairs a diff can compare, so a count change is detectable even when the vendor never bumps a version number.

## The search-fallback rule

Some canonical URLs are JS-rendered and return empty to a plain fetch, and some anchors return stale in-progress wording. Mark those sources `search_fallback: true` and confirm them through search rather than a direct fetch. This is a per-source property the skill sets from experience, not something the helper guesses.

## The two-tier landing

Where a confirmed change is written, and whether a human sees it first, splits into two tiers. This asymmetry is the load-bearing safety property, because skill content is executable instruction and a self-authored change to it, graded by the same model that authored it, reward-hacks.

The autonomous tier writes directly. A confirmed `version` change rewrites its stamp line in place through `updateStampInText`, and new research items prepend to a rolling digest through `prependAndPrune`, pruned to a cap. These are data, and getting one wrong has low blast radius.

The human-gated tier never rewrites. When a change touches the method itself, namely a new taxonomy category that should become question-bank rows, a new lens angle, a new control theme, the workflow writes a `proposedUpdateBlock` at the top of the affected file and reports it, and a human decides. The helper's `classifyChange(change, {impliesMethod})` routes between the two, but `impliesMethod` is always the skill's judgment passed in, never inferred. A change whose kind is none routes to skip.

On a skill's first run the stored state is null, so every source diffs as `first-run`, which is the whole of that first execution rather than an edge case. It routes through the same classifier: `first-run` lands autonomously when the skill passes `impliesMethod` false, meaning stamp on first sight with no gate, and human-gated when it passes true, exactly as a later `version` or `new-content` change does.

Landing needs named destinations, and the skill owns them. An autonomous `version` change rewrites the stamp in the skill's reference doc through `updateStampInText`, which matches by the stamp's current value as a literal string, replaces the first stamp whose value matches, and leaves the rest untouched, so a skill keeps its stamps unique or accepts first-match. An autonomous digest entry prepends to the skill's rolling watch file through `prependAndPrune`. A human-gated `proposedUpdateBlock` is written to the top of the method file it would change, where a human sees it on the next run. When both a version and new content change in one observation, `diff` reports the version change first, so a version bump wins.

## The trigger

`~/.claude` is not a synced git repository, so there is no cloud checkout for a scheduled job or a commit hook to run against. The default trigger is therefore refresh-on-use: run the refresh as an early step of the skill's own initialization, which guarantees currency at the moment the skill is put to work. Two blind spots need a light second tier that still needs no repo. A rarely-invoked skill carries unnoticed staleness, so a `last_check_timestamp` in state plus a cheap local sweep that flags anything past a max-age ceiling turns silent staleness into a visible signal. A time-sensitive feed (a CVE, a threat advisory) goes stale on the world's clock rather than on use-time, and its value is prompting you to look, which refresh-on-use cannot do, so that subset keeps a scheduled push on top.

## Freshness state

Freshness state is a record separate from the registry, of what was last seen and when. It lives at `<skill>/State/currency-state.json` for a new skill, and an existing skill may keep its current state filename where the shape already matches, as a skill may with an existing `State/last-check.json`. One home per skill, named in the skill's own workflow so a second skill does not invent a divergent location. The helper's `loadState`, `saveState`, and `stampSource` maintain it: a top-level `last_check_timestamp` and a per-source map of `last_checked`, and where relevant `last_hash`, `last_title`, and `current_version`. Content-hash dedup through `contentHash(s)` lets a `posts` source detect a genuinely new item rather than a re-fetch of the same one.

## What class of update this fits

This contract is the mechanism for Class A, external facts and knowledge, and it carries the version-stamp discipline that Class B, tool and dependency versions, reuses to keep a documented command surface honest against the installed binary. It is not for Class D, a skill's own instructions, which is never autonomous and is governed by the mutation-tier and skill-lifecycle tooling. The four update classes and the per-class decision guide are in Part 2 of the methodology report.

Class C, a data corpus, reuses the freshness state, the `registrySetDrift` set-drift, the stamp, and content hashing to preview a destructive sync before it runs, namely which items a mirror would gain and which local-only items it would delete, while the sync itself and the delete-guard judgment stay the skill's own. Here the tracked registry is the live corpus discovered from disk, not a static `sources.json`, so `validateRegistry` does not apply and only the state and set-drift plumbing is reused. The Fabric skill's `Tools/PatternCurrency.ts` is the worked class-C example, and the fact that its `registrySetDrift` call is the exact function the class-B Recon pilot added is the sign the plumbing genuinely consolidates across classes. Two classes across one axis of variation is a demonstration of consolidation, not a universal proof of it. Two honest seams go with the class-C fit. The corpus is stamped as one synthetic source holding the set hash and count rather than one source per item, which is the right grain for a whole-corpus mirror. And the set-drift keys on item name, so a same-name content change is neither gained nor deleted and the sync updates it silently, meaning the class-C mechanism is a delete-guard, not a content-drift detector; a skill that needs per-item content currency adds a content hash per item on top.

## Adopting this in a new skill

Repointing existing skills is a separate migration. The shape of adoption for a new skill is short, and it is what the helper is built to make routine.

1. Write a `Data/sources.json` per the schema above, and run `bun LIFEOS/TOOLS/Currency.ts validate <path>` on it until it reports zero errors.
2. Keep a `State/currency-state.json`, and load it at the start of the skill's refresh step with `loadState`.
3. For each source, fetch it with the skill's own prompt and fallback, compute an observed `{version}` for a version source or `{hash}` from `contentHash` for a posts source, and call `diff(observed, state.sources[id])`.
4. For each change, decide `impliesMethod` yourself, call `classifyChange`, and land it: `updateStampInText` or `prependAndPrune` for autonomous, `proposedUpdateBlock` for human-gated.
5. Call `stampSource` for every source checked, then `saveState`.

The helper is the plumbing for every step. What stays the skill's own is the fetch, the `impliesMethod` judgment, and the landing destinations.

One import note, learned from the first pilot. A skill's Tools are often symlinked from a source repo, so a relative import will not reach `LIFEOS/TOOLS`. Import the helper by a configured anchor, preferring `CLAUDE_CONFIG_DIR` and falling back to the home directory, with a dynamic import.

```
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const helper = await import(join(CLAUDE_DIR, "LIFEOS", "TOOLS", "Currency.ts"));
```

Dynamic import trades compile-time checking for runtime resolution, so keep a small local interface for the functions you use and assert at load that each is present, which turns a signature drift in the helper into a loud, clear failure rather than a cryptic one. The Recon skill's `Tools/ToolCurrency.ts` is the worked example, and it wraps the helper for a class-B tool-version updater rather than a knowledge feed, which shows the mechanism is the same for both.

A version-tracking consumer should also check set-drift, namely a source observed but not in the registry (something new appeared) or in the registry but not observed (something was removed), through the helper's `registrySetDrift`. Silent set-drift is the same failure as silent version-drift, one level up.

