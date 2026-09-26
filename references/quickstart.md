# Quick mode — the whole contract on one page

> **Read this instead of `00-contract.md` + `ledger.md` when the mode is
> `quick`.** Those two are 500 lines and every session pays for what it reads;
> a quick run needs the twelve commands below and four rules. Everything here
> is enforced by the same scripts, so a quick run is a smaller run, not a
> looser one.
>
> **Escalate the moment the run stops being quick.** If the user asks for a
> systematic review, a full extraction matrix, a knowledge graph, dual-pass
> screening, or more than ~15 sources: stop, read `references/00-contract.md`
> and `references/ledger.md`, and restart at the mode they asked for. Do not
> improvise the parts this page leaves out.

## Setup

`$SKILL` is where this skill is installed (`.kiro/skills/deep-research-pipeline`,
`.claude/skills/…`, or wherever your harness put it — `SKILL.md` sits next to
`scripts/`). `<search>` and `<fetch>` are your harness's web search and page
fetch tools; name them out loud at the scope gate. Full map: `harness.md`.

```powershell
$SKILL = ".kiro/skills/deep-research-pipeline"
$L = "$SKILL/scripts/ledger.ts"; $S = "$SKILL/scripts/scholar.ts"
$env:DRP_RUN_DIR = "research/20260903-your-topic-slug"    # every --dir defaults to this
$R = $env:DRP_RUN_DIR                                     # only for paths like $R/sources/S001.md
New-Item -ItemType Directory -Force -Path "$R/sources","$R/raw" | Out-Null
bun "$SKILL/scripts/memory.ts" show      # stage 0
bun $S doctor                            # stage 0 — before the budget goes
bun $L init --topic "the sharpened question" --mode quick --lang en
```

```bash
SKILL=".kiro/skills/deep-research-pipeline"
L="$SKILL/scripts/ledger.ts"; S="$SKILL/scripts/scholar.ts"
export DRP_RUN_DIR="research/20260903-your-topic-slug"
R="$DRP_RUN_DIR"
mkdir -p "$R/sources" "$R/raw"
bun "$SKILL/scripts/memory.ts" show
bun $S doctor
bun $L init --topic "the sharpened question" --mode quick --lang en
```

Forward slashes work everywhere. Never hand-edit `ledger.json`. An unknown flag
is rejected with a suggestion and nothing is written — if it is not in
`bun $L --help`, it does not exist.

If the run is `--evidence-tier verified`, add `--peer-reviewed` to every
`bun $S search` and `bun $S cites`, register the tier as an exclude criterion,
and exclude against it with reason `not-peer-reviewed`.

> **One PowerShell caution.** Variable names are case-insensitive, so a loop
> written `foreach ($r in $rows)` overwrites `$R`. Name loop variables `$rec`,
> `$sid`, `$row`. Commands do not need `$R` at all — `--dir` falls back to
> `DRP_RUN_DIR` — and `ledger.ts` refuses a clobbered `--dir` by name rather
> than writing somewhere strange.

## The four rules

1. **Read, not glimpsed.** A metadata hit is a lead. Only `mark-read` makes a
   source citable, and it refuses unless the text is cached at
   `sources/S###.md`.
2. **Every claim cites `[S###]`; every number carries a verbatim quote.**
   `add-evidence` refuses (exit 2) a summary asserting a figure its quote does
   not contain.
3. **Never hand-count.** Every number in the report comes from `stats`. Paste
   the `stats --md` block; `audit --report` re-derives it and errors on an edit.
4. **Refuse rather than guess.** No evidence, no answer — name the gap in
   `gaps.md`. Never bridge one from background knowledge.

Quick mode works from abstracts by design, so a figure resting on an
abstract-only source is a *warning* here rather than an error. It is still a
weak number: say where it came from.

## The run, nine stages, condensed

Registering criteria **before** searching is what makes screening reviewable.

```bash
bun $L add-criterion --id C1 --direction include --text "…"       # stage 1, before any search
bun $L log-query  --q "…" --source web --hits 20 --kept 3         # stage 2, every query
bun $L add-source --file $R/raw/hits.json --from openalex         # stage 2
bun $L mark-read  --all-from-abstract                             # stage 2 — makes them citable
bun $L screen       --batch $R/screen.jsonl                       # stage 3
bun $L add-evidence --batch $R/evidence.jsonl                     # stage 3
bun $L claim  --text "…" --evidence E001,E002 --consensus moderate # stage 4
bun $L verify --claim CL001 --question "…" --answer "…" --status supported  # stage 5
bun $L bib   > $R/references-list.md                              # stage 7
bun $L stats --md                                                 # stage 7 — paste into REPORT.md
bun $L stats > $R/08-audit.md ; bun $L audit --report >> $R/08-audit.md   # stage 8, must exit 0
```

Stage 6 (knowledge graph) and the extraction matrix are skipped in quick mode.

**Batch, do not loop.** `screen`, `add-evidence`, `extract`, `claim` and
`verify` take `--batch f.jsonl` — one JSON object per line, keys named like the
flags without dashes. Every CLI call is an agent turn, so this is the difference
between 300 turns and 6. Lines that fail are named and not written; fix those
and resubmit only those.

## The citable path — four commands per source

Skipping the second is the most common way a run fails its audit.

```bash
bun $L add-source   --file hits.json --from openalex        # metadata_at — a lead
bun $L mark-read    --source S001 --from-abstract           # read_at — now citable
bun $L screen       --source S001 --verdict include --criteria "C1:pass"
bun $L add-evidence --source S001 --question SQ1 --score 8 --summary "…" --quote "…"
```

Full text instead of the abstract, when an OA copy exists:

```bash
bun $S fetch     --id 10.1371/journal.pone.0266781 --out $R/sources/S001.md
bun $L mark-read --source S001 --scope fulltext
```

`fetch` exits 3 when there is no OA full text — a fact about the source. Then
read the page with `<fetch>` and write `$R/sources/S001.md` yourself, or screen
it out as `unobtainable`.

## Files a quick run must produce

Exact and case-sensitive. `REPORT.md` is uppercase.

`00-brief.md` · `01-plan.md` · `02-search-log.md` · `03-screening.md` ·
`04-synthesis.md` · `05-verification.md` · `REPORT.md` · `gaps.md` ·
`08-audit.md` · `references-list.md` · `sources/S###.md`

`REPORT.md` also needs an `Evidence current as of <date>` line (or
`<!-- drp:as-of YYYY-MM-DD -->` in a language the audit does not read).

## Gates

Stop and hand control back. Present numbered options in prose and wait; assume
no question widget. Record each one — `audit` reports a gate that never
happened.

```bash
bun $L gate --pass scope --note "user approved the brief"
```

In quick mode: **scope** (end of stage 1), **coverage+sufficiency** collapsed
into one (end of stage 3), **audit** (end of stage 8), **memory** (stage 9 —
ask once what to remember; a blank answer writes nothing at all).

## When something goes wrong

| Symptom | What it means |
|---|---|
| exit 0 | ok |
| exit 1 | error, or the audit found something |
| exit 2 | **refused by design** — not a bug to retry around; fix the input |
| exit 3 | `scholar.ts fetch` found no full text — a fact, not a failure |
| `no ledger at …` | wrong `--dir`; set `DRP_RUN_DIR` once and stop passing it |
| lost your place | `bun $L state` — stage, gates, and what is missing |

`state` is also how you resume after a context compaction: it derives the
position from the ledger and the files on disk, so resuming is a lookup rather
than a reconstruction.
