# The run contract — read at stage 0, before anything is written

`SKILL.md` is the map: modes, stages, gates. This file is the contract the run
is held to — where files go, what the tooling is, and the thirteen rules the
audit exists to enforce. It moved out of `SKILL.md` because every session pays
for `SKILL.md` whether it starts a run or not, and this only matters once a run
begins.

Read it once, at stage 0, together with `harness.md` (what `<search>`,
`<fetch>`, `<subagent>` and `$SKILL` mean here) and `ledger.md` (the tooling
contract). Then start stage 1.

## Getting started

```powershell
$SKILL = ".kiro/skills/deep-research-pipeline"   # see harness.md — adjust per harness
$L = "$SKILL/scripts/ledger.ts"
$S = "$SKILL/scripts/scholar.ts"
$M = "$SKILL/scripts/memory.ts"
$env:DRP_RUN_DIR = "research/20260902-your-topic-slug"   # every --dir defaults to this
bun $M show                              # stage 0 — cross-run memory
bun $S doctor                            # stage 0 — preflight, before the budget goes
New-Item -ItemType Directory -Force -Path "$env:DRP_RUN_DIR/sources","$env:DRP_RUN_DIR/raw" | Out-Null
bun $L init --topic "the question" --mode standard --lang en
```

```bash
SKILL=".kiro/skills/deep-research-pipeline"
export DRP_RUN_DIR="research/20260902-your-topic-slug"
bun "$SKILL/scripts/memory.ts" show
bun "$SKILL/scripts/scholar.ts" doctor
mkdir -p "$DRP_RUN_DIR/sources" "$DRP_RUN_DIR/raw"
bun "$SKILL/scripts/ledger.ts" init --topic "the question" --mode standard --lang en
```

Forward slashes work on every platform. `--dir` still overrides `DRP_RUN_DIR`
wherever you pass it, and `$R = $env:DRP_RUN_DIR` stays handy for paths like
`$R/sources/S001.md`. Keep intermediate files inside the research directory
rather than a system temp path — it keeps the run self-contained and resumable.

> **PowerShell trap.** Variable names are case-insensitive, so
> `foreach ($r in $rows)` silently overwrites `$R`. `ledger.ts` refuses such a
> `--dir` by name before writing anything, but the fix is upstream: set
> `$env:DRP_RUN_DIR` and stop passing `--dir`, or name loop variables `$rec`,
> `$sid`, `$row`.

If the user gave only a bare topic, do not start searching: stage 1 exists
because a sharpened question changes which sources matter.

## Output layout

Create the directory at the start of stage 1. Filenames are exact and
case-sensitive; `REPORT.md` is uppercase. The generated table in
`ledger.md` ("Run directory") is the authority — it is printed from the same
constants `ledger.ts state` checks against.

```
research/<YYYYMMDD>-<slug>/
├── 00-brief.md            question, framing, criteria, perspectives
├── 01-plan.md             outline, sub-queries, routes, targets
├── 02-search-log.md       every query: source, hits, kept
├── 03-screening.md        include/exclude decisions + PRISMA funnel
├── 03-extraction.md       Elicit matrix        (ledger.ts matrix)
├── 04-synthesis.md        perspectives, debate, findings, contradictions
├── 05-verification.md     CoVe questions, Reflexion changes
├── 06-knowledge-graph.md  entity-relation map, structural gaps
├── graph.json             nodes + edges, `ledger_ids` on each (audit checks them)
├── 07-refine-log.md       Self-Refine iterations, score history
├── REPORT.md              the deliverable, fully cited
├── gaps.md                open questions, what to research next
├── 08-audit.md            stats + audit output, shown to the user
├── references-list.md     bibliography        (ledger.ts bib)
├── stats.json             counts              (ledger.ts stats --json)
├── ledger.json            single source of truth — only ledger.ts writes it
├── raw/                   executor JSON returns, merged via add-source --file
└── sources/S###.md        cached source text — required before a source is citable
```

Slug: lowercase, hyphenated, from the topic, max 6 words. The markdown files
are renderings of `ledger.json` plus prose. Two things live at the skill root,
outside any run: `memory.md` (cross-run process knowledge, loaded at stage 0,
written at stage 9, never evidence) and `cache/` (cross-run source text, see
`ledger.ts cache`). Neither may exist yet; that is the normal first-run state.

## Tooling

| Operation | Tool |
|---|---|
| Web search, page fetch | `<search>`, `<fetch>` — mapped in `harness.md` |
| Sub-query fan-out | `<subagent>`, general-purpose role, one per sub-query |
| Preflight before spending the budget | `bun $S doctor` |
| Scholarly retrieval, full text, snowballing, dedup, link check | `bun $S` (`scholar.ts`) |
| Ledger, counts, PRISMA, run state, audit, matrix, bibliography | `bun $L` (`ledger.ts`) |
| Cross-run memory | `bun $M` (`memory.ts`) |

`bun` is required. Run `--help` on any script for its command list; a flag that
is not in `--help` does not exist, and the scripts enforce that — an unknown
flag is rejected with a suggestion rather than ignored.

**Cheap by default.** `screen`, `add-evidence`, `extract`, `claim` and `verify`
take `--batch records.jsonl` (one JSON object per line) and apply the lot in one
call. Prefer it: the cost of this pipeline is agent turns, not disk. Set
`DRP_RUN_DIR` once instead of passing `--dir` several hundred times.

**The counting rule.** Every number in a deliverable comes from `ledger.ts
stats` or `audit` — sources found, deduped, screened, excluded by reason,
included, evidence records, claims by consensus, verification results. Never
hand-count. `stats --md` prints the funnel inside `<!-- drp:stats -->` markers;
paste that block into the deliverable and `audit --report` re-derives every
number and errors on any that was edited. If your prose disagrees with the tool,
the tool is right.

**Ids.** Scripts assign `S###` sources, `E###` evidence, `CL###` claims, `V###`
verification; you assign `C#` criteria. Report body text cites `[S007]`; no
other pattern is a real id (`ledger.md` lists the lookalikes to translate).
Never edit `ledger.json` by hand — the scripts write it atomically under a lock,
which is what makes parallel executor merges safe.

**Precedence.** The scripts are the final authority on any count, threshold,
filename, vocabulary value, or flag; a reference file that disagrees is a bug.
That is why `ledger.md` carries a *generated* contract block rather than a
retyped one, and why `bun $L contract --check references/ledger.md` fails when
the two drift. Exit codes: 0 ok · 1 error or audit findings · 2 refused by
design (do not retry around it) · 3 `scholar.ts fetch` found no full text.
After editing a script, run `bun test scripts/`.

## Non-negotiables

Numbered, and referred to by number across the reference files.

1. **Read, not glimpsed.** A metadata hit is a lead. A source becomes citable
   only when its text is cached at `sources/S###.md` and `mark-read` has stamped
   `read_at`. `metadata_at` alone never qualifies; `scholar.ts fetch` gets the
   text where an OA copy exists.
2. **Every claim carries evidence ids.** Body text cites `[S007]`; `ledger.ts
   bib` resolves ids to title, authors, year, venue, DOI/URL, access date.
   `audit --report` errors on a citation that is unknown, excluded, or unread.
3. **Refuse rather than guess.** If the evidence does not support an answer, say
   so, name what is missing, and put it in `gaps.md`. Never bridge a gap with
   background knowledge presented as a finding.
4. **Numbers need quotes.** Any figure, percentage, sample size, or benchmark
   needs a verbatim quote plus locator. `add-evidence` refuses (exit 2) when the
   summary asserts a number the quote does not contain. See also 13.
5. **Contradictions get reported, never averaged.** Conflicting findings appear
   side by side, both cited, with a classification.
6. **Date everything.** Publication year and `read_at` per source, plus an
   explicit "Evidence current as of" line. In an output language the audit does
   not read, mark it `<!-- drp:as-of YYYY-MM-DD -->`. Flag claims that depend on
   fast-moving facts.
7. **Separate observation from inference.** Source findings and your own
   synthesis go in visibly different sections. Label inference as inference.
8. **Report the search, not just the result.** `02-search-log.md` records every
   query, its source, hit counts, and language, via `log-query --lang <iso>`.
9. **Output language follows configuration.** Deliverables in `--output-lang`
   (always one language); quotes in the original with translation alongside.
   `--query-lang` is the one axis that may name several languages at once
   (e.g. `vi,de,ja,ru`) — see `references/02-retrieval.md` §2.8 — and is
   unaffected by this rule. What you *say to the user* — gate questions,
   clarifications, the stage 9 ask — follows `--interaction-lang`, which
   defaults to `--output-lang`; set it only when the user wants to converse in
   one language and receive the report in another.
10. **Hypothetical documents are scratch.** HyDE output is for vocabulary only.
    Its invented numbers never enter a note, the ledger, or the report.
11. **The audit is a gate, not a note.** `audit --report` must exit 0 before
    delivery. Name a genuinely unfixable finding to the user instead of hiding
    it.
12. **Memory is process knowledge, never evidence.** `memory.md` may hold
    preferences, scoping habits, which sources paid off, pitfalls — never a
    finding, a number, or anything needing a `[S###]`. It can change how you
    search; it can never supply a fact, shorten a search, or excuse a citation.
    Nothing is remembered unless the user asks at stage 9.
13. **A figure needs the full text.** A number from an abstract has no method,
    population, or caveat behind it, so `audit` errors on abstract-sourced
    figures (warning in `quick`, which works from abstracts by design) and
    `systematic` mode caps abstract-only evidence at context level.

## Reference map

`SKILL.md`'s pipeline table names each stage's numbered reference file; read it
when you reach that stage, not before. These are the ones it does not:

| File | Read it for |
|---|---|
| `quickstart.md` | The whole contract on one page, for `quick` mode only — read it *instead of* this file and `ledger.md` when the run is quick, and escalate to both the moment it stops being |
| `harness.md` | `$SKILL`, and what `<search>` / `<fetch>` / `<subagent>` are here. **First** |
| `ledger.md` | Tooling contract: the generated vocabularies, thresholds, filenames, exit codes and environment, plus the schema, batch input and the citable path. **Second** |
| `scoping-criteria.md` | Criterion wording, framing scaffolds, perspective discovery, interactive turns |
| `executor-contract.md` | Sub-query routes, the subagent file-return contract |
| `02-apis.md` | OpenAlex, Semantic Scholar, Crossref, Europe PMC: choosing a source, snowballing mechanics, dirty metadata. On demand during stage 2 |
| `screening-extraction.md` | Matrix columns, matrix reading heuristics |
| `evidence-synthesis.md` | Relevance scoring, contradiction classes, consensus labels |

Lineage: GPT Researcher, STORM and Co-STORM, HyDE and FLARE, OpenAlex and
Semantic Scholar, Elicit and ASReview, PaperQA2, CoVe and Reflexion,
Self-Refine.
