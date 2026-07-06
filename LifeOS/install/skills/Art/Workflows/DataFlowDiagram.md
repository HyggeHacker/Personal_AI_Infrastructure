# Data-Flow Diagram (Threat Model) Workflow

**Renders a threat-model data-flow diagram to executive standard: distinct Shostack element shapes, dashed trust boundaries, a legend, labeled directional flows, and live-versus-future paths.**

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the DataFlowDiagram workflow in the Art skill to render a threat-model data-flow diagram"}' \
  > /dev/null 2>&1 &
```

Running **DataFlowDiagram** in **Art**...

---

## Purpose

The data-flow diagram is the spine of a threat model. It answers "what are we working on?", it is where the threat enumeration happens (threats cluster at trust boundaries), and it is the one figure a CTO will stare at longest. This workflow is the rendering muscle: it turns a verified element-and-flow list into a client-facing figure that reads as authored, not as default Visio or SmartArt.

**Use this workflow for:**
- A system-level DFD with trust boundaries for a threat-model deliverable
- A clean request-flow lifecycle figure for an executive audience
- Any diagram where Shostack DFD notation and trust-boundary discipline are load-bearing

**This is NOT for:**
- Freeform architecture diagrams with no threat-model semantics (use `TechnicalDiagrams.md`)
- Generic flowcharts or sequence diagrams (use `Mermaid.md`)
- Illustrative or conceptual art (use `Essay.md`)

---

## The conventions are authoritative in the foundation

The notation, layering, tool decision table, and rendering paths are defined once, in the threat-modeling foundation. Read it before rendering:

`/Users/j/.claude/skills/_THREAT_MODEL_FOUNDATION/DfdGuide.md`

This workflow does not restate that methodology. It renders to it. Every figure this workflow produces must honor the following, all of which are specified in full in `DfdGuide.md`:

- **The five Shostack element types, visually distinct.** External entity as a rectangle, process as a rounded rectangle, data store as open-ended parallel lines (a cylinder is the accepted stand-in when the tool has no parallel-lines shape), data flow as a single or double-headed arrow, trust boundary as a closed dashed box. A reader has to tell them apart at a glance.
- **Trust boundaries are dashed; everything else is solid.** A boundary marks a change in trust level and is exactly where a flow crossing it becomes an attack surface. Draw the headline boundaries first and let the elements arrange around them.
- **A legend.** Map every shape and every line style. This is the single biggest visible lift from amateur to authored.
- **Labeled, directional flows.** Every arrow shows direction and says what it carries, not merely that something flows.
- **One official icon set per cloud, used consistently.** AWS, Azure, or GCP official icons, one set per provider across the whole figure.
- **Color is never load-bearing.** Color may map to a trust zone or to live-versus-future state and to nothing else. The figure must survive grayscale, photocopying, and color-blind readers. Encode meaning in shape and line style, not hue.
- **Live versus future paths shown solid versus dotted.** Anything not yet built (a future write path, a not-yet-live release) renders dotted, and the node is marked future in its label.

The no-fabrication rule from `DfdGuide.md` is not optional here: every node, flow, and trust boundary must reflect a verified element of the threat model before it renders. See "No fabrication" below.

---

## Default path: author as-code in D2

D2 is the standing default because it is as-code, diffable, reproducible, and agent-maintainable, and its containers are first-class trust boundaries. The agent writes the `.d2` text directly and renders it with the `d2` CLI. There is no external service dependency and the source diffs cleanly, so the same file feeds both the threat-model and gap-findings sections and regenerates on demand when the architecture is refined.

```bash
# render (SVG for the report, or swap the extension for PNG/PDF)
d2 diagram.d2 diagram.svg
```

If `d2` is not installed: `brew install d2` (macOS) or see https://github.com/terrastruct/d2.

### D2 skeleton for a small DFD

Cloud nodes use the Terrastruct icon library (https://icons.terrastruct.com/). This skeleton shows an external user, two processes, a data store, a trust boundary drawn as a dashed container, and a dashed future path. Copy it, then replace every node with a verified element.

```d2
# dfd.d2   render:  d2 dfd.d2 dfd.svg
direction: right

# ---- Legend: map every shape and every line style ----
legend: Legend {
  near: top-left
  ee: External entity  { shape: rectangle }
  pr: Process          { shape: rectangle; style.border-radius: 20 }
  ds: Data store       { shape: cylinder }
  tb: Trust boundary   { style.stroke-dash: 4 }
}

# ---- External entity: sits outside every trust boundary (rectangle) ----
user: End user {
  shape: rectangle
}

# ---- Trust boundary as a first-class dashed container ----
platform: Platform trust boundary {
  style.stroke-dash: 4

  api: API gateway {
    shape: rectangle
    icon: https://icons.terrastruct.com/aws%2FArchitecture-Service-Icons%2FApp-Integration%2FAmazon-API-Gateway.svg
  }
  agent: Agent orchestrator {
    shape: rectangle
    style.border-radius: 20   # rounded rectangle = process
  }
  store: Session store {
    shape: cylinder           # cylinder stands in for the DFD data-store shape
  }
}

# ---- Live flows: solid, directional, labeled with what they carry ----
user -> platform.api: request + JWT
platform.api -> platform.agent: verified call
platform.agent -> platform.store: read / write context

# ---- Future path: dotted line, node marked future ----
writer: Write MCP (future) {
  style.stroke-dash: 3
}
platform.agent -> writer: config write (future) {
  style.stroke-dash: 3
}
```

Notes on the mapping: D2 has no native parallel-lines data-store shape, so `cylinder` is the accepted stand-in; a rounded rectangle (`border-radius`) reads as a process; a plain rectangle reads as an external entity or a technical component. Keep boundaries dashed (`stroke-dash: 4`) and future paths dotted (`stroke-dash: 3`) so the distinction survives grayscale. If a turnkey layout engine helps, TALA (https://terrastruct.com/tala/) improves boundary-heavy layouts.

### Practical as-code workflow

1. Feed the verified element and flow list to emit a first D2 pass.
2. Hand-correct the topology, then add the dashed trust boundaries and the cloud icons.
3. Tune the layout and whitespace so nothing crowds.
4. Render with `d2 diagram.d2 diagram.svg`.
5. Commit the `.d2` so the diff is the change log, and drop the exported vector into the report.

---

## Secondary paths

D2 is the default. Reach for one of these only when its specific strength outweighs reproducibility. All are covered in `DfdGuide.md`.

- **Mermaid (text-native, weaker trust boundaries).** Git-embeddable and text-native, but it has no native trust-boundary primitive, so it is the weakest choice for a hero figure. Use it for a simple git-embedded diagram, and cross-link to the existing Art Mermaid workflow at `Workflows/Mermaid.md` for the sketchy-aesthetic variant.
- **Lucidchart (highest polish, describe-to-edit).** The pick when pure executive aesthetic and easy non-engineer editing outrank reproducibility. Turn on the official AWS, Azure, and GCP icon libraries, build the DFD with proper element shapes, draw trust boundaries as dashed containers, add the legend, and export vector SVG or high-DPI PDF. The agent describes changes and Lucid AI executes them rather than authoring directly, so you trade a diffable source file for polish. Confirm the edit API is live before relying on the full edit loop.
- **Excalidraw (fast first draft).** The fastest path to an agent-built draft with zero setup: author from the JSON element format, use low-opacity background zones as trust boundaries, set roughness to zero for clean strokes, checkpoint to persist state across calls, and export. The default aesthetic is hand-drawn and there are no official cloud icons, so treat it as a first draft and re-author the final in D2 or Lucidchart.

---

## Completeness backstop: model in Threat Dragon first

When rigor matters, model the system in OWASP Threat Dragon before rendering the client-facing figure. Threat Dragon is free, open source, JSON in git, OWASP-aligned, and runs STRIDE-per-element, so it is the correctness backstop that guarantees no element, flow, or trust boundary is missed. Model there first, confirm the enumeration is complete, then render the polished figure in D2 (or a secondary path). See https://owasp.org/www-project-threat-dragon/.

---

## No fabrication

Every node, flow, and trust boundary must reflect a verified element from the threat model before it renders. Do not add a component because the topology "looks incomplete," and do not infer a data store or a flow that no source confirms. If an element is asserted but not yet verified, either leave it out or mark it explicitly as unconfirmed in its label; never let an unverified element render as settled fact. A figure a CTO trusts is one where every shape traces to something real.

---

## Output convention: stage to Downloads first

Per the Art skill's global rule, all output stages to `~/Downloads/` first for preview before any copy into a project directory. Render there, open it, confirm it visually, and only then copy the vector into the deliverable.

```bash
# author, render, and stage for preview
d2 ~/Downloads/dfd.d2 ~/Downloads/dfd.svg
open ~/Downloads/dfd.svg
```

Keep the `.d2` source alongside the exported figure so the diagram stays reproducible. After the user approves, copy both the source and the exported vector to the final destination.

---

## Validation

Before declaring the figure done, confirm:

- [ ] All five Shostack element types are visually distinct, and a reader can tell a data store from a process at a glance
- [ ] Trust boundaries are dashed closed containers; every other line is solid
- [ ] A legend maps every shape and every line style
- [ ] Every flow is directional and labeled with what it carries
- [ ] One official icon set per cloud, used consistently
- [ ] The figure survives grayscale: no meaning depends on color
- [ ] Live paths are solid, future paths are dotted, and future nodes say so in their labels
- [ ] Every node, flow, and boundary traces to a verified element (no fabrication)
- [ ] Aligned grid, generous whitespace, one type family, nothing crowded
- [ ] Staged to `~/Downloads/` and previewed before any copy into the deliverable

## Execution Log

After completing the workflow, append a single JSONL entry:

```bash
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","skill":"Art","workflow":"DataFlowDiagram","input":"8_WORD_SUMMARY","status":"ok|error","duration_s":SECONDS}' >> ~/.claude/PAI/MEMORY/SKILLS/execution.jsonl
```
