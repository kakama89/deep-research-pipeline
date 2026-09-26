# Stage 1 — Planning (GPT Researcher style)

> **Wiring** · Tools: `ledger.ts init`, `ledger.ts add-criterion` — criteria
> are pre-registered *before* any search. Run `memory.ts show` first (stage 0)
> and surface anything it holds at the scope gate
> (`references/09-learning-loop.md` §9.7). Depth for this stage lives in
> `references/scoping-criteria.md` (framing-scaffold table, criterion wording,
> perspective discovery, perspective-guided Q&A, outline, interactive turns)
> and `references/executor-contract.md` (sub-query routes and the subagent
> return contract). Contract: the generated block in `references/ledger.md`
> wins over this file on any count, threshold, filename, or tool name.

**Leaving this stage** — `ledger.ts state` holds it open until all of this is
true: `00-brief.md` and `01-plan.md` exist, at least one criterion is
registered (`add-criterion`, **before** any search), and
`gate --pass scope` is recorded.

Planning is the cheapest correction point. A minute here saves ten minutes of
wasted search and synthesis. This stage turns a raw topic into a sharpened
question, pre-registered criteria, perspectives, an outline, and a set of
non-overlapping sub-queries — then stops at the scope gate for approval.

This file owns two things and defers everything else:

- **Sub-query decomposition** (§1.2) — how to split the question so stage 2
  can fan out.
- **Wiring the ledger** (§1.3) — `init` and `add-criterion`, the two commands
  SKILL.md mandates for this stage.

Topic sharpening, the framing scaffolds, criterion wording, perspectives, the
Q&A protocol, and the outline all live in `references/scoping-criteria.md`.
Query *craft* (turning a sub-query into concrete search strings) lives in
`references/02-retrieval.md` §2.2 — do not restate it here.

---

## 1.1 Topic sharpening — pointer

Restate the request as one primary question plus sub-questions that are
specific, bounded, and unambiguous. Use `scoping-criteria.md` §1.1 for the
method and the framing-scaffold table (PICO / SPIDER / technology-evaluation /
landscape-scan / causal) — do not re-specify those scaffolds here.

**The one scaffold decision rule:** pick the scaffold from the implicit intent
of the request.

| If the user is… | Scaffold |
|---|---|
| comparing an intervention against a baseline | PICO |
| studying an experience or qualitative phenomenon | SPIDER |
| choosing a tool, library, vendor, or architecture | Technology evaluation |
| surveying a field or market | Landscape scan |
| asking why or how something happens | Causal |

When two fit, prefer the one whose fields you can actually fill from the
request; an empty scaffold field is a vague query waiting to happen.

**Sub-question count:** do not state a range here. It is set by the mode table
in `SKILL.md` — `quick` 3–5, `standard` 6–10, `systematic` 10–20,
`interactive` rolling. Defer to that table; if it ever changes, this file needs
no edit.

Pin the boundary conditions (time window, geography, languages, accepted
evidence types, explicit out-of-scope) as described in `scoping-criteria.md`.
They decide inclusion and become criteria in §1.3. When the topic needs more
than the default topic-language-plus-English coverage — e.g. Vietnamese,
German, Japanese, and Russian sources all in scope — pin that language list
explicitly at scope time and pass it as `--query-lang vi,de,ja,ru` (see
`references/02-retrieval.md` §2.8); do not leave it to `auto` and hope the
agent branches into languages nobody asked for.

---

## 1.2 Sub-query decomposition

This is the planner half of GPT Researcher: decide *what to ask*. The executor
half — going and reading — is stage 2. Each sub-query must satisfy all four
tests:

1. **Independently searchable.** It stands alone in a search box: no pronouns,
   no "the above", no dependency on another sub-query's result.
2. **Non-overlapping.** Two sub-queries that return the same pages waste
   budget. Apply the non-overlap test: if you can predict that two queries
   would surface the same top results, merge them or narrow one so their
   expected result sets are disjoint.
3. **Outline-covering.** The union of sub-queries spans the whole primary
   question. Every `thin` or `empty` outline section (from
   `scoping-criteria.md` §1.5) needs at least one sub-query aimed at it. Map
   them explicitly.
4. **Answerable by a document that exists.** You are retrieving, not
   generating. "What is the optimal X" has no document; "what tradeoffs do
   practitioners report choosing X over Y" does.

Assign each sub-query a **route**, because source type determines which backend
stage 2 uses:

| Route | Use when | Backend |
|---|---|---|
| `web` | current events, product docs, tutorials, incident write-ups, news; topics < 6 months old | `<search>` + `<fetch>` |
| `scholarly` | peer-reviewed evidence, systematic reviews, formal studies, well-studied phenomena | `scholar.ts` |
| `both` | topics with both practitioner and academic literature | both legs |

Default to `both` when unsure. Send anything with a publication record to the
scholarly route — it gives citation counts, DOIs, and snowballing that web
search cannot.

Record the decomposition as a table (this is `01-plan.md`'s core):

```markdown
| ID | Sub-query | Route | Targets section | Source-type priority | Notes |
|----|-----------|-------|-----------------|----------------------|-------|
| SQ1 | "<phenomenon> production failure modes post-mortem" | web | §3 | practitioner reports, incident write-ups | |
| SQ2 | "<phenomenon> latency benchmark evaluation" | both | §4 | peer-reviewed, benchmarks | |
| SQ3 | "<phenomenon> systematic review" | scholarly | §1 | reviews, surveys | |
| SQ4 | "<vendor> <phenomenon> pricing 2026" | web | §5 | vendor docs — mark vendor-sourced | |
```

Note execution order alongside it: which sub-queries can run in parallel, which
depend on an earlier result, and which are contingent ("only if SQ2 finds X").

---

## 1.3 Wire the ledger (mandatory before any search)

Stage 1 must run exactly two ledger commands, in this order, before stage 2
issues a single query. Variables `$L` and `$R` are as defined in
`references/ledger.md` (`$L` = path to `ledger.ts`, `$R` = the run directory).

**Create the run.** `init` writes the ledger schema and records the topic,
mode, and output language:

```bash
bun $L init --dir $R --topic "the sharpened primary question" \
  --mode standard --lang en
```

`--lang` is the `--output-lang` from configuration; `--mode` is the run mode.
Create `$R`, `$R/sources` and `$R/raw` first (see `00-contract.md` "Getting started").

**Pre-register every criterion.** Write inclusion and exclusion criteria *now*,
from the table you built per `scoping-criteria.md` §1.2. Assign your own `C#`
ids (one series for both directions), give each a direction and the stage at
which it is decidable:

```bash
bun $L add-criterion --dir $R --id C1 --direction include \
  --text "Reports a primary empirical result on <phenomenon>" --stage abstract
bun $L add-criterion --dir $R --id C2 --direction include \
  --text "Published 2021 or later, or cited >200 times" --stage metadata
bun $L add-criterion --dir $R --id C3 --direction exclude \
  --text "Opinion or marketing content with no method" --stage abstract
bun $L add-criterion --dir $R --id C4 --direction exclude \
  --text "Retracted or withdrawn" --stage metadata
```

Allowed `--direction`: `include`, `exclude`. Allowed `--stage`: `metadata`,
`abstract`, `fulltext`. Re-registering an existing id is refused — amendments
must be visible, so pick a new id if you change your mind. These criteria are
what stage 3 screens against; if they are not in the ledger, screening has
nothing to reference.

---

## 1.4 Deliverables and output location

Stage 1 produces `00-brief.md` and `01-plan.md`. Their full templates live in
`scoping-criteria.md` §1.7 (`00-brief.md`) and the decomposition table in §1.2
above (`01-plan.md`). **`references/00-contract.md` "Output layout" owns the directory tree, and the generated "Run directory" table in `ledger.md` is the authority for the names,
the exact, case-sensitive filenames** — do not restate the tree here, and never
invent filenames such as `03-analysis.md`, `04-draft.md`, or a `report/`
folder. If an older note uses a name not in that table, it is a legacy
label; use the generated name.

`01-plan.md` should carry: the sub-query table (§1.2), execution order, and any
contingency rules (broaden a query returning too few sources, flag conflicting
evidence for perspective analysis, document an unanswerable sub-query as a gap
and proceed).

---

## 1.5 Scope gate

The scope gate is a mandatory checkpoint at the end of stage 1. Present a
concise summary and wait — this harness has no question widget, so offer
numbered options in prose.

Show the user:

1. Primary question (1–2 sentences).
2. Sub-question count and list.
3. Mode and source budget (from the `SKILL.md` mode table).
4. Perspectives (names + one line each; one must be adversarial).
5. Key boundary conditions.
6. Anything memory contributed at stage 0.
7. Any environment limit `scholar.ts doctor` reported — no PDF converter, an
   unreachable or throttled API, no `RESEARCH_CONTACT` for the Unpaywall route.
   These decide what the evidence base can be, and the user should hear it now
   rather than as an excuse in the audit.

Offer: (1) approve and proceed, (2) adjust the question, (3) adjust criteria,
(4) add or drop a perspective, (5) change mode. Apply the choice, re-present if
needed, and cap at about three iterations before asking for explicit approval
of the current state. Never skip the gate, even when the topic seems clear —
correcting course here costs nothing; after search it costs the whole search
budget.

**Before leaving stage 1, verify:** `00-brief.md` and `01-plan.md` exist with
all sections filled; `ledger.ts init` has run; every criterion is registered
with `add-criterion`; every sub-query has a route and a target section; at
least one adversarial perspective is present; boundary conditions are explicit;
the user has approved at the scope gate.
