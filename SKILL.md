---
name: deep-research-pipeline
description: >
  Nine-stage, citation-grounded research on an auditable evidence ledger:
  scope with pre-registered criteria, retrieval and snowballing, screening,
  evidence carrying verbatim quotes, multi-perspective synthesis, verification,
  knowledge-graph gap analysis, report, an audit gate, and a cross-run learning
  loop. Every count comes from scripts/ledger.ts and the audit must exit 0
  before delivery. Produces a fully cited report under research/<date>-<slug>/.
  Use for literature reviews, technology and vendor evaluations, market scans,
  systematic reviews, standards and regulation research, due diligence, and any
  question where "where did that claim come from?" must have an answer.
---

# Deep Research Pipeline

Turn a question into a report whose every claim traces to a source you actually
read. Each stage contributes one inspectable step; `scripts/ledger.ts` makes the
chain auditable, and `audit --report` must exit 0 before anything is delivered.

Use it when the answer needs sources: literature reviews, technology and vendor
evaluations, systematic reviews, market scans, standards or regulation research,
due diligence, "what does the evidence actually say about X". Do not use it for
questions answerable from the codebase (read the code), single-fact lookups (one
search is enough), or requests for an opinion rather than evidence.

Invocation: `<topic or question> [--mode quick|standard|systematic|interactive]
[--query-lang auto|<iso>[,<iso>...]] [--output-lang <iso>] [--interaction-lang <iso>]
[--from YEAR] [--sources N] [--evidence-tier any|verified]`

## Configuration

| Argument | Values | Default | Meaning |
|---|---|---|---|
| `<topic>` | free text | required | The research topic or question |
| `--mode` | `quick`, `standard`, `systematic`, `interactive` | `standard` | Depth. There are exactly four |
| `--query-lang` | `auto`, or a comma-separated list of ISO 639 codes | `auto` | Language(s) to search in. `auto` detects from the topic (topic language + English). A list (e.g. `vi,de,ja,ru`) searches each one, plus English as a fallback for technical gaps unless English is already listed. Passed to `init --query-lang`; log each query's language with `log-query --lang` |
| `--output-lang` | ISO 639 code (`en`, `vi`, `ja`, `pt-BR`, …) | follows the user | Deliverable language. Passed to `init --lang` |
| `--interaction-lang` | ISO 639 code, or `auto` | follows `--output-lang` | Language the agent **talks to the user** in: gate questions, clarifications, the stage 9 memory ask. Not written to the ledger and never affects the report. Set it only to talk in one language while delivering in another |
| `--from` | `YYYY` | 5 years ago | Earliest publication year; exclusion reason `outside-window` |
| `--sources` | integer | mode-dependent | Override the source target |
| `--evidence-tier` | `any`, `verified` | `any` | `verified` accepts only peer-reviewed work — journal, conference and proceedings papers with a DOI. Preprints, blogs, vendor documentation, theses, patents and news are excluded on **both** legs |

| Stage | `quick` | `standard` | `systematic` | `interactive` |
|---|---|---|---|---|
| 1 Scope | light | full | full + pre-registered protocol | full + mind map |
| 2 Sub-queries | 3–5 | 6–10 | 10–20 | rolling |
| 2 Retrieval | web + OpenAlex, 1 FLARE round | + S2 + snowball 1 gen, 2–3 rounds | all sources + snowball 2 gen + saturation | driven by the discourse |
| 3 Screening | relevance only | criteria pass | dual-pass + PRISMA | as needed |
| 3 Evidence | abstracts | abstracts + OA full text | full text mandatory for included | on demand |
| 3 Matrix | skip | key columns | full matrix | skip |
| 4 Synthesis | single perspective | multi-perspective + debate (2 rounds) | full debate (3+) + consensus scoring | roundtable turns |
| 5 Verification | `audit` only | CoVe + 1 Reflexion loop | CoVe + 3 Reflexion loops | CoVe on final claims |
| 6 Graph | skip | core entities + relations | full graph + gap analysis | optional |
| 7 Report | brief | full + 1 Self-Refine pass | review-grade + 3 passes | running summary + final |
| 8 Audit | `audit --report` passes | + manual checks | + `scholar.ts verify` on every locator | + manual checks |
| Sources | 10–15 | 25–40 | 60+ screened | grows with turns |
| Budget | ~25 searches, ~15 fetches | ~60 / ~40 | 150+ / 60+, resumable | conversational |

Stage 9 runs in every mode. Budgets are tool-call guides, not wall-clock
promises — fetching is the slow part. If the request implies a different depth
("quick look", "systematic review", "let us explore this together"), propose the
matching mode at the scope gate rather than switching silently. Source titles,
author names, and verbatim quotes stay in their original language whatever
`--output-lang` says; translate a quote only alongside the original.

Three language axes, kept separate: `--query-lang` (what you search in — a
*set*, possibly several languages at once), `--output-lang` (what the report
is written in — always one language), and `--interaction-lang` (what you say
to the user in — gates, clarifications, the stage 9 ask — also one language).
The last defaults to `--output-lang`, so a single `--output-lang vi` makes both
the report and the conversation Vietnamese; set `--interaction-lang` only to
split them (e.g. talk in Vietnamese, deliver in English). `--output-lang`
reaches the ledger via `init --lang`; `--query-lang` reaches it too, via
`init --query-lang` and per-query via `log-query --lang`; `--interaction-lang`
is your behaviour, not stored state.

`--evidence-tier verified` cuts hard: measured on one query, OpenAlex went
from 29,787 works to 7,592, and the reference list of a survey shrank from 24
usable records to 5. Raise it at the **scope** gate, not the coverage gate —
by then the budget is spent. It is the right default for clinical, regulatory
and due-diligence work, and the wrong one for anything fast-moving in CS or
ML, where the result that matters is six months from a journal. Say which tier
ran, in the report.

## Before stage 1

**In `quick` mode, read `references/quickstart.md` and nothing else.** It is one
page — the twelve commands, the four rules, the citable path, the gates — and it
is enough for a whole quick run. The three reads below cost ~500 lines that a
15-source run never uses. Escalate to them the moment the request stops being
quick.

In `standard`, `systematic` and `interactive` mode, three reads, in this order,
and then you have everything:

1. `references/harness.md` — sets `$SKILL`, and maps `<search>`, `<fetch>` and
   `<subagent>` (written that way everywhere) onto this harness's real tools.
2. `references/00-contract.md` — output layout, tooling, and the thirteen
   non-negotiables the audit enforces.
3. `references/ledger.md` — the tooling contract: vocabularies, thresholds,
   schema, batch input, exit codes, the citable path.

Then read each stage's own reference file when you reach it, not before — each
is self-contained. Load memory (`memory.ts show`) and run the preflight
(`scholar.ts doctor`) as part of stage 0; before a `systematic` run use
`doctor --strict`, which exits 1 when the environment cannot meet the standard
that mode promises.

The four rules that decide whether a run is worth anything, in short — the full
thirteen are in `00-contract.md`:

- **Read, not glimpsed.** Only `mark-read` makes a source citable; a metadata
  hit is a lead.
- **Every claim carries evidence ids**, and every number carries a verbatim
  quote from a full text.
- **Never hand-count.** Every figure in a deliverable comes from `ledger.ts
  stats`; `audit --report` re-derives them and errors on a hand edit.
- **Refuse rather than guess.** Unsupported answers go to `gaps.md`, never into
  the report on background knowledge.

After a long run or a context compaction, `bun $L state --dir $R` says which
stage you are in and what is missing; use it instead of reconstructing from
memory.

## The pipeline

| # | Stage | Does | Reference | Produces |
|---|---|---|---|---|
| 0 | Load memory | `memory.ts show`, then `scholar.ts doctor` (`--strict` before a `systematic` run) — an environment with no PDF converter or no reachable API changes what stage 2 can deliver, and learning that at stage 8 wastes the run. Missing memory file = normal, say nothing | `00-contract.md`, `harness.md`, `09-learning-loop.md` §9.7 | — |
| 1 | Scope, criteria, perspectives, outline | Sharpen the question; write criteria **before** searching; 3–6 perspectives; outline; non-overlapping sub-queries with routes | `01-planning.md` + `scoping-criteria.md`, `executor-contract.md` | `00-brief.md`, `01-plan.md`; `init`, `add-criterion`. **Gate** |
| 2 | Retrieval | HyDE vocabulary, FLARE gap rounds, `<subagent>` fan-out on the web leg, `scholar.ts` on the scholarly leg, snowball, dedup, saturation — then the `mark-read` pass that makes anything citable | `02-retrieval.md` (+ `02-apis.md` on demand), `executor-contract.md` | `02-search-log.md`, `sources/`; ledger sources. **Gate** |
| 3 | Screening, evidence, extraction | Criteria per source with verdict, reason, quote; evidence scored 1–10 against each question; the matrix. Use `--batch` — this is where a run's turn cost is decided | `03-screening.md` + `screening-extraction.md`, `evidence-synthesis.md` | `03-screening.md`, `03-extraction.md`. **Gate** |
| 4 | Synthesis | Perspective-guided synthesis, then adversarial debate per contested claim until consensus or documented disagreement | `04-synthesis.md` + `evidence-synthesis.md` | `04-synthesis.md`; claims, contradictions |
| 5 | Verification | Questions answered from the evidence alone, the self-refuting test, Reflexion loop. `unsupported` must be fixed, downgraded, or moved to `gaps.md` | `05-verification.md` | `05-verification.md`; verification records |
| 6 | Knowledge graph | Entities and relations from verified findings, `ledger_ids` on every node and edge (`audit` checks them), structural gaps. Skipped in `quick` | `06-knowledge-graph.md` | `06-knowledge-graph.md`, `graph.json` |
| 7 | Report | Outline-first, citing as you go; paste the `stats --md` block rather than retyping counts; self-critique, one coherence pass | `07-report.md` | `REPORT.md`, `gaps.md` |
| 8 | Audit | `stats`, `audit --report` (exit 0 — it checks the report, `graph.json`, the counts block, and that the gates were recorded), `scholar.ts verify`, then the manual checks | `08-quality-gates.md` | `08-audit.md`. **Gate** |
| 9 | Learning loop | Ask **once** what to remember. Blank, "no", or silence writes **nothing** — no file, no empty section, no record of the asking. Otherwise `memory.ts add` one-sentence lessons, then `compact --apply` | `09-learning-loop.md` | entries in `memory.md`, or nothing. **Gate** |

## Gates

Five points where you stop and hand control back. Present numbered options in
prose and wait — assume no question widget. Record each approval with
`ledger.ts gate --dir $R --pass <name>`: `state` uses it to know the stage is
behind you, and `audit` reports a gate that was never recorded (an error in
`systematic` mode), so skipping one is visible rather than silent.

1. **scope** (end of stage 1) — question, criteria, perspectives, outline, mode,
   budget, the harness map, plus anything memory contributed. Cheapest place to
   correct course.
2. **coverage** (end of stage 2) — what was found, how much is actually read,
   saturation status, notable absences.
3. **sufficiency** (end of stage 3) — which questions have solid evidence, which
   are thin. Offer: write now, or search deeper.
4. **audit** (end of stage 8) — report, audit findings, remaining gaps.
5. **memory** (end of stage 9) — the exact sentences you propose to remember,
   shown before writing.

In `quick` mode collapse gates 2 and 3. In `interactive` mode every roundtable
turn is an implicit gate.

## Start

```bash
SKILL="<where this skill is installed>"          # harness.md
export DRP_RUN_DIR="research/20260902-your-topic-slug"
bun "$SKILL/scripts/memory.ts" show              # stage 0
bun "$SKILL/scripts/scholar.ts" doctor           # stage 0 — before the budget goes
mkdir -p "$DRP_RUN_DIR/sources" "$DRP_RUN_DIR/raw"
bun "$SKILL/scripts/ledger.ts" init --topic "the question" --mode standard --lang en
```

PowerShell and the rest of the setup are in `references/00-contract.md`. Read
that and `references/ledger.md`, then `references/01-planning.md`, and begin
stage 1. In `quick` mode read `references/quickstart.md` instead of those first
two. If the user gave only a bare topic, do not start searching: stage 1 exists
because a sharpened question changes which sources matter.
