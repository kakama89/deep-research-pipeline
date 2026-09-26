# Stage 6 — Knowledge Graph Construction

> **Wiring** · Stage 6 runs **no ledger command**. `graph.json` is written
> directly because it is derived analysis, regenerable from the ledger — not
> new evidence. Every node and edge carries the real ledger ids it came from
> (`S###` sources, `E###` evidence, `CL###` claims) in a `ledger_ids` array,
> so a graph assertion traces back to a quote. Internal node keys (e.g.
> `n_transfer_learning`) may stay human-readable but are **local to
> graph.json** — they are not ledger ids. **Skipped in `quick` mode.**
>
> There is no confidence float, no quality float, and no source tier. The
> only score in the pipeline is the 1–10 relevance integer on an evidence
> record; the graph does not reintroduce others.

**Leaving this stage** — `ledger.ts state` holds it open until `graph.json` and
`06-knowledge-graph.md` exist, and skips it entirely in `quick` mode. `audit`
then checks the graph: every `ledger_ids` entry must exist, be included and be
read, and every edge endpoint must be a node in the same file.

## Overview

This stage turns verified findings into a structured graph. The graph is
both a deliverable and an analytical tool: it reveals structural patterns —
gaps, clusters, bridges — that prose narratives obscure.

**Inputs:** verified `CL###` claims from **Stage 5** (stage 4 wrote the
claims; stage 5 verified them, so stage 6 consumes the *verified* set),
their `E###` evidence, and `S###` source metadata.

**Outputs:** `06-knowledge-graph.md` (human-readable summary), `graph.json`
(the full structure), and new gaps appended to `gaps.md`.

| Prose report | Knowledge graph |
|---|---|
| Linear narrative | Network structure |
| Emphasizes conclusions | Emphasizes relationships |
| Hides gaps | Makes gaps visible |
| Domain-focused | Cross-domain by nature |

The graph does not replace the report; it shows the topology the report
cannot.

---

## 6.1 Entity extraction

Extract these entity types from verified claims and their evidence:

| Type | Description | Examples |
|---|---|---|
| `concept` | Abstract ideas, theories | "transfer learning" |
| `method` | Techniques, algorithms | "gradient descent" |
| `tool` | Software, systems | "PyTorch" |
| `person` | Researchers, authors | "Hinton" |
| `organization` | Institutions, labs | "DeepMind" |
| `metric` | Measures, criteria | "F1 score" |
| `dataset` | Benchmarks, corpora | "ImageNet" |
| `finding` | A verified claim | "Transformers beat RNNs on long sequences" |

Procedure: scan each verified claim; identify noun phrases that are
discrete concepts/actors/tools/measures; classify into a type; give a local
graph key; write a 1–2 sentence description; and record the ledger ids the
entity was drawn from in `ledger_ids`.

**Normalization** avoids fragmentation: merge synonyms ("ML" + "machine
learning"), resolve acronyms to a canonical label with the acronym as an
alias, keep labels in Title Case, split versions when capabilities differ
("GPT-3" vs "GPT-3.5"), and keep org and product distinct ("Google" vs
"TensorFlow").

**Provenance requirement.** Every entity must trace to at least one ledger
id. An entity that cannot be linked to a verified source is either
hallucinated (discard) or implicit background (note it, do not enter it in
the graph). No node without `ledger_ids`.

---

## 6.2 Relation extraction

Typed relations between entities:

| Relation | Inverse | Description |
|---|---|---|
| `CAUSES` | `CAUSED_BY` | Causal, evidence-supported |
| `IMPROVES` | `DEGRADES` | Performance/quality impact |
| `USES` | `USED_BY` | Tool/method utilization |
| `COMPARES_WITH` | `COMPARES_WITH` | Symmetric comparison |
| `CONTRADICTS` | `CONTRADICTS` | Symmetric conflict (mirror a ledger `contradiction`) |
| `EXTENDS` | `EXTENDED_BY` | Builds on prior work |
| `PART_OF` | `CONTAINS` | Compositional hierarchy |
| `EVALUATED_ON` | — | Tested on dataset/benchmark |
| `PROPOSED_BY` | — | Attribution to person/org |
| `SUPERSEDES` | `SUPERSEDED_BY` | Replacement/obsolescence |

Procedure: for each entity pair co-occurring in a claim or evidence
passage, decide whether a meaningful relation exists, classify it, set
direction (or mark symmetric), and record every supporting ledger id in
`ledger_ids`. **Every edge must carry at least one `E###` or `CL###` id — no
unsupported edges.** If two relation types hold between one pair, create two
edges.

A `CONTRADICTS` edge should mirror an existing ledger `contradiction`
record. Never blend the two sides — see
`references/evidence-synthesis.md` for the never-average rule.

---

## 6.3 Graph construction — graph.json

```jsonc
{
  "metadata": {
    "topic": "…",
    "generated_at": "2026-09-02T22:00:00Z",
    "mode": "systematic",
    "node_count": 47,
    "edge_count": 128
  },
  "nodes": [ /* see below */ ],
  "edges": [ /* see below */ ]
}
```

One node (the `id` is a local graph key; provenance lives in `ledger_ids`):

```jsonc
{
  "id": "n_transformer",
  "label": "Transformer",
  "type": "method",
  "description": "Self-attention sequence architecture.",
  "ledger_ids": ["CL002", "E018", "S007"],
  "degree": 11
}
```

One edge (traces to the evidence/claims behind the relation):

```jsonc
{
  "source": "n_transformer",
  "target": "n_rnn",
  "relation": "SUPERSEDES",
  "context": "Sequence tasks with long-range dependencies",
  "ledger_ids": ["E024", "CL011"]
}
```

Construction steps: build nodes for all entities; build edges for all
relations; compute each node's degree; validate that every edge endpoint
references an existing node; validate that every id in `ledger_ids` exists
in the ledger; write `graph.json`. There are no weight, confidence, or
quality fields to compute — edges rank by how many independent `ledger_ids`
back them.

`ledger.ts audit` performs those two validations for you and adds the ones only
the ledger can answer: a `ledger_ids` entry that names an excluded or unread
source is an error, and a node or edge with no `ledger_ids` at all is a warning
— an unsourced node is a hunch drawn as a fact. Run `bun $L audit --dir $R`
after writing the file rather than at stage 8, when a fabricated id is cheap to
fix. `--no-graph` skips the file if you are deliberately mid-build.

---

## 6.4 Structural analysis

**Hubs** — nodes with disproportionately many connections. Compute degree
(in + out); flag nodes above mean + 1.5 σ; rank descending. A hub with few
backing `ledger_ids` is a red flag: a supposedly central concept with thin
support.

**Isolates** — nodes with 0–2 connections. Each is noise (remove),
a gap (→ `gaps.md`), or an emerging area (→ cross-domain insights).

**Clusters** — densely interconnected groups (internal edge density >
external). Label by the dominant type and highest-degree member; they
usually map to sub-topics.

**Bridges** — nodes whose edges span 2+ clusters. High betweenness plus
inter-cluster edges marks a bridge; these are candidate cross-domain
insights.

**Missing edges** — pairs that domain reasoning says should connect but no
evidence does. These feed gap detection.

---

## 6.5 Structural-gap typology

| Gap type | Definition | Detection |
|---|---|---|
| **Structural** | Expected connection, no evidence | Missing-edge analysis |
| **Temporal** | Only old sources for a key entity | Newest backing source `year` < current − 3 |
| **Methodological** | A finding rests on one method type | One method entity linked to a `finding` |
| **Geographic** | Evidence concentrated in one region | `organization` entities cluster geographically |

Each detected gap is appended to `gaps.md` with its type, the entities
involved, why it is a gap, suggested search queries, and a priority. A
structural-gap entry, for example, names entity A and entity B, the
expected relation, the reasoning, two candidate queries, and priority
high/medium/low.

---

## 6.6 Cross-domain bridge detection

The highest-value insights come from unexpected links between domains.

Method: take the clusters from §6.4; find bridge entities connecting them;
analyze *why* the entity appears in both; assess whether findings in domain
X could transfer to domain Y. Rate novelty:

- **Known transfer** — already documented (low novelty).
- **Plausible transfer** — logical, undocumented (medium).
- **Surprising connection** — unexpected, worth investigating (high).

A cross-domain insight records the bridge entity, the two clusters, the
connection, the implication, and the `ledger_ids` that support it. Present
high-novelty bridges prominently in the report:

> "Findings from **[domain X]** may apply to **[domain Y]** because
> **[bridge entity]** operates similarly in both — **[evidence summary,
> with ledger ids]**."

---

## 6.7 06-knowledge-graph.md — required sections

All counts come from the graph you built (which is itself derived from
`ledger.ts` records); never invent numbers.

- **Key entities** — top entities by connection count: rank, label, type,
  connections, description.
- **Relationship summary** — node count, edge count, most common relation
  types, strongest connections (most `ledger_ids`).
- **Clusters** — for each: label, core entities, key internal relations,
  external links.
- **Gaps** — table of type, entities, priority, suggested action.
- **Cross-domain insights** — narrative per bridge, ranked by novelty.

`graph.json` holds the full machine-readable structure for visualization,
downstream use, and reproducibility.

---

## 6.8 Mode variations

| Aspect | `quick` | `standard` | `systematic` | `interactive` |
|---|---|---|---|---|
| Entities | **skip stage** | top ~30 by mention | all | optional |
| Relations | skip | between top 30 | all pairs | optional |
| Structural analysis | skip | hubs + clusters | hubs, isolates, clusters, bridges, missing edges | optional |
| Gap detection | skip | structural only | all four types | optional |
| Cross-domain | skip | skip | full | optional |
| Output | none → Stage 7 | abbreviated | full `.md` + `graph.json` | as needed |

Standard-mode entity selection: rank candidates by mention count, take the
top ~30, ensure at least two entities per type appear.

---

## 6.9 Execution checklist

1. [ ] Entity extraction complete; all types considered.
2. [ ] Normalization done — synonyms merged, acronyms resolved.
3. [ ] Relation extraction done — pairs checked (mode-appropriate).
4. [ ] `graph.json` built and validated (endpoints exist; every
       `ledger_ids` entry resolves to a real `S###`/`E###`/`CL###`).
5. [ ] Structural analysis run (mode-appropriate).
6. [ ] Gap detection run (mode-appropriate); `gaps.md` updated.
7. [ ] Cross-domain discovery run (systematic).
8. [ ] `06-knowledge-graph.md` written with all sections.
9. [ ] Every node and edge carries `ledger_ids`.

---

## 6.10 Example (compressed)

Topic: "Impact of LLMs on software development."

1. Entities: LLM (concept), GitHub Copilot (tool), developer productivity
   (metric), HumanEval (dataset), OpenAI (organization).
2. Relations: Copilot `USES` LLM; Copilot `EVALUATED_ON` HumanEval; LLM
   `IMPROVES` developer productivity; Copilot `PROPOSED_BY` OpenAI — each
   edge carrying the `E###`/`CL###` ids behind it.
3. Build graph: ~5 nodes, 4 edges; compute degrees.
4. Structural: "LLM" is a hub; "HumanEval" an isolate if singly linked.
5. Gaps: no edge from LLM to code security → structural gap; all sources
   2021–2023 → temporal gap for 2024–2025.
6. Write `06-knowledge-graph.md` + `graph.json`.

---

*End of Stage 6 — next is Stage 7, the report.*
