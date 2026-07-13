# Update Tools Workflow

Keeps the Project Discovery toolchain current under the currency contract (`LIFEOS/DOCUMENTATION/Currency/CurrencySystem.md`). The default action is a read-only staleness check. An actual update is an explicit operator decision, never a reflexive blind `pdtm -update-all`, and the versions in use are stamped so an engagement is reproducible.

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the UpdateTools workflow in the Recon skill to check recon tool currency"}' \
  > /dev/null 2>&1 &
```

Running the **UpdateTools** workflow in the **Recon** skill to check recon tool currency...

## Trigger Phrases
- "check recon tools", "are recon tools stale"
- "update recon tools", "update project discovery tools"
- "update pdtm tools", "upgrade recon tooling"

## Reproducibility contract

Borrowed from the `_AZURE_PENTEST` tool-freshness discipline, because a silent version change alters findings underneath the operator.

- **Check and warn never mutate.** The staleness check reports drift and changes nothing.
- **Upgrades are explicit-only and never mid-engagement.** Updating the toolchain during an active engagement changes the tools the findings were produced with. Update between engagements, deliberately.
- **Stamp records the versions used.** After an update, the installed versions are stamped into freshness state so the engagement is reproducible and the next check has a baseline.

## Execution

### 1. Check for drift (default, read-only)

```bash
bun ~/.claude/skills/Security/Recon/Tools/ToolCurrency.ts check
```

This diffs installed versions against the last stamped state and warns on any drift. It never updates or mutates anything. If pdtm is not installed it says so and does nothing.

### 2. Update (explicit, between engagements only)

When you have decided to update, and you are not mid-engagement:

```bash
pdtm -self-update      # update pdtm itself
pdtm -update-all       # update the managed tools
```

### 3. Stamp the versions in use

Immediately after an update, record what is now installed so state has a fresh baseline. The very first time you run this, stamp on its own establishes the initial baseline with no update having happened, which is a one-time setup step. After that, stamp records the versions in use following an explicit update.

```bash
bun ~/.claude/skills/Security/Recon/Tools/ToolCurrency.ts stamp
bun ~/.claude/skills/Security/Recon/Tools/ToolCurrency.ts status   # confirm the recorded versions
```

## Registry and state

- Registry of tracked tools: `skills/Security/Recon/Data/sources.json` (21 pdtm tools as version-tracked sources; validate with `bun ~/.claude/LIFEOS/TOOLS/Currency.ts validate skills/Security/Recon/Data/sources.json`).
- Freshness state: `skills/Security/Recon/State/currency-state.json`.
- The stamp-and-diff plumbing is the shared helper `LIFEOS/TOOLS/Currency.ts`; `ToolCurrency.ts` adds only the pdtm version observation and the staleness judgment.

## Installed Tools

Project Discovery tools managed by pdtm:

| Tool | Purpose |
|------|---------|
| subfinder | Subdomain enumeration |
| httpx | HTTP probing and tech detection |
| nuclei | Vulnerability scanning |
| naabu | Port scanning |
| dnsx | DNS toolkit |
| chaos-client | Chaos subdomain database |
| katana | Web crawling |
| tlsx | TLS/SSL analysis |
| cdncheck | CDN detection |
| asnmap | ASN mapping |
| mapcidr | CIDR manipulation |
| uncover | Search engine dorking |
| alterx | Subdomain wordlist generation |
| shuffledns | DNS bruteforcing |
| cloudlist | Cloud asset discovery |
| notify | Notification system |
| interactsh-client | OOB interaction server |
| proxify | HTTP proxy |
| tldfinder | TLD discovery |
| urlfinder | URL extraction |
| vulnx | Vulnerability aggregation |

## API Key Configuration

Keys are stored in:
- `~/.config/PAI/.env` (PAI environment variables)
- `~/.config/subfinder/provider-config.yaml` (Subfinder sources)

To authenticate with PDCP (ProjectDiscovery Cloud Platform):
```bash
# Get your PDCP API key from https://cloud.projectdiscovery.io
pdtm -auth YOUR_PDCP_KEY
```

## Verification

After an update and stamp, spot-check that tools run:
```bash
subfinder -version
httpx -version
nuclei -version
echo "example.com" | subfinder -silent | head -5
```
