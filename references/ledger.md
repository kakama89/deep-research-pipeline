# The ledger â€” tooling contract

> **Read this before stage 1.** It is the only reference file that is not
> optional, because every other stage writes through it. Where any other
> file disagrees with this one or with the scripts, this one wins.

`ledger.json` is the single source of truth for one research run. Two
scripts own it. You never hand-edit it. A third script owns the one piece of
state that outlives a run.

`$SKILL` below is wherever this skill is installed â€” set it once from
`references/harness.md`, which also maps `<search>`, `<fetch>` and
`<subagent>` onto the tools this harness actually has.

```powershell
# PowerShell â€” set once, reuse all run
$L = "$SKILL/scripts/ledger.ts"
$S = "$SKILL/scripts/scholar.ts"
$M = "$SKILL/scripts/memory.ts"
$env:DRP_RUN_DIR = "research/20260902-your-topic-slug"
$R = $env:DRP_RUN_DIR        # still handy for paths like $R/sources/S001.md
```

```bash
# POSIX
L="$SKILL/scripts/ledger.ts"
S="$SKILL/scripts/scholar.ts"
M="$SKILL/scripts/memory.ts"
export DRP_RUN_DIR="research/20260902-your-topic-slug"
R="$DRP_RUN_DIR"
```

`bun $L --help`, `bun $S --help`, `bun $M --help` list every command. A flag
that is not in `--help` does not exist, and the scripts enforce that: an
unknown flag is rejected with a suggestion and nothing is written. That is
deliberate â€” a silently ignored `--locater` used to produce a record with no
locator that no audit rule could distinguish from an honest one.

**`--dir` comes from `DRP_RUN_DIR`** when you do not pass it, which is the fix
for the trap below as well as for 400 repetitions of the same path.

> **PowerShell trap.** Variable names are case-insensitive, so a loop written
> `foreach ($r in $records)` silently overwrites `$R`. `ledger.ts` now catches
> the result â€” a `--dir` that is a stringified object (`System.Collections.Hashtable`),
> an unexpanded `$R`, or cmd-style `%TEMP%` is refused by name before anything is
> written, instead of surfacing later as `no ledger at â€¦/ledger.json`. The fix is
> still the same: set `$env:DRP_RUN_DIR` and stop passing `--dir`, or name loop
> variables `$rec`, `$sid`, `$row`.

## Five rules

1. **The counting rule.** Every number in a deliverable â€” sources found,
   deduped, screened, excluded by reason, included, evidence records,
   claims by consensus, verification results â€” comes from
   `ledger.ts stats` or `ledger.ts audit`. Never hand-count. If a count in
   your prose disagrees with the tool, the tool is right. `stats --md` makes
   this checkable rather than trusted: it prints the funnel inside
   `<!-- drp:stats -->` markers with a machine-readable payload, and
   `audit --report` re-derives every number in that block and errors on any
   that was edited.

2. **Never hand-edit `ledger.json`.** Writes go through `ledger.ts` so ids
   stay stable, dedup runs, the write is atomic, and the audit stays
   meaningful. Mutating commands take a lock (`$R/ledger.lock`), which is what
   makes it safe to merge several executors' returns at once; a hand edit
   during a fan-out is how records disappear. If a field you want is not in the
   schema below, the pipeline does not track it â€” say so in prose instead of
   inventing state.

3. **Metadata is not reading.** `metadata_at` is stamped automatically when
   an API returns a record. It proves nothing. `read_at` is set only by
   `mark-read`, which refuses unless the text is cached at
   `$R/sources/S###.md`. Only `read_at` makes a source citable.

4. **Exit codes mean something.** 0 ok Â· 1 error or audit findings Â· 2
   **refused by design** â€” the rule you hit is not a bug to retry around
   (`add-evidence` with a number the quote does not contain, `memory.ts add`
   with nothing to remember) Â· 3 `scholar.ts fetch` found no full text, which
   is a fact about the source.

5. **The audit is a gate.** `bun $L audit --dir $R --report` must exit 0
   before delivery. Without `--report` it checks the ledger against itself
   and never opens the deliverable.

## Knowing where you are

A long run gets its context compacted. `state` reconstructs the position from
the ledger and the files on disk, so resuming is a lookup rather than a guess:

```bash
bun $L state --dir $R                 # stage, gates, counts, what is missing
bun $L gate  --dir $R --pass scope --note "user approved the brief"
```

A stage whose files are all present still counts as open until its gate is
recorded â€” the gates are handovers to the user, the one piece of state no tool
can derive. Gate names: `scope`, `coverage`, `sufficiency`, `audit`, `memory`.

## Stage â†’ command map

| Stage | Commands |
|---|---|
| 0 Load memory | `memory.ts show` â€” before anything else. `scholar.ts doctor` â€” preflight |
| 1 Planning | `ledger.ts init`, `add-criterion` (before any search), `gate --pass scope` |
| 2 Retrieval | `scholar.ts search / cites / trend / dedup / fetch`, `ledger.ts add-source`, `mark-read` (`--all-from-abstract` for the abstract tier), `log-query`, `gate --pass coverage` |
| 3 Screening + evidence | `ledger.ts screen`, `add-evidence`, `extract`, `matrix`, `gate --pass sufficiency` â€” all four take `--batch` |
| 4 Synthesis | `ledger.ts claim`, `contradiction` |
| 5 Verification | `ledger.ts verify`, `audit` (mid-run) |
| 6 Knowledge graph | none â€” `graph.json` is written directly (analysis, not evidence), and `audit` validates its ids |
| 7 Report | `ledger.ts bib`, `stats --md` |
| 8 Audit | `ledger.ts stats`, `audit --report` (must exit 0), `scholar.ts verify`, `gate --pass audit` |
| 9 Learning loop | `memory.ts add` (exit 2 = nothing to remember), `compact --apply`, `stats`, `gate --pass memory` |
| Any time | `ledger.ts state` (where am I), `ledger.ts cache` (the cross-run source cache) |

## Preflight

```bash
bun $S doctor              # add --offline to skip the network probes, --json for a machine read
bun $S doctor --strict     # before a systematic run â€” exits 1 on what the mode cannot do without
```

The strictest rules here (non-negotiables 1 and 13: read the text, no figure
without full text) depend on the weakest part of the environment â€” an OA copy, a
PDF converter, an API key that is not being throttled. `doctor` reports bun,
`pdftotext` (without it, PDF-only sources cannot be converted, so `fetch` exits 3
on them and every figure they carry is unusable), which keys are set (never their
values), `DRP_RUN_DIR`, the shared cache and its format version, and whether
OpenAlex, Semantic Scholar, Crossref and Europe PMC answer. Exit 1 only when no
scholarly API is reachable at all; everything else is a warning to disclose at the
scope gate. Run it at stage 0 â€” a missing converter discovered at stage 8 costs
the whole run.

`--strict` also exits 1 on the two checks that limit **what the evidence base can
be** rather than how fast it is gathered: no `pdftotext`, and no OpenAlex (which
is the only route to `cites` snowballing and `trend`). Both are mandatory in
`systematic` mode, so run `--strict` before promising one. Missing API keys stay
warnings under `--strict` â€” they cost throughput, not correctness. Plain `doctor`
names which checks *would* fail `--strict`, so the escalation is one flag away
rather than a surprise.

## The two stores that outlive a run

`ledger.json` is per-question and carries a `version`. The other two persist, so
they carry one too â€” a newer build must not silently misread an older store, and
an older build must not silently truncate a newer one.

| Store | Version marker | Older than the marker | Newer than this build |
|---|---|---|---|
| `memory.md` | `<!-- drp:memory v1 -->` in the header | read normally, stamped on the next write | **read-only**: `show` works, `add` / `replace` / `forget` / `compact --apply` refuse rather than drop what they cannot parse |
| `cache/` | `cache/.drp-cache.json` | read normally, stamped on the next write | every read misses and nothing is written â€” the cost is a wasted fetch, never a wrong quote |

`memory.ts stats` and `ledger.ts cache` both print the version they found.
Clear an unreadable cache with `ledger.ts cache --prune-days 0`, or point
`DRP_CACHE_DIR` somewhere fresh; it re-stamps itself once empty.


## Batch input

`screen`, `add-evidence`, `extract`, `claim` and `verify` accept
`--batch records.jsonl`: one JSON object per line (a JSON array file works too),
keys named like the flags without the dashes. `score` may be a number,
`evidence` an array, `criteria` an object, and `scope_note` is accepted for
`--scope-note`.

```bash
bun $L screen --batch $R/screen.jsonl
# {"source":"S001","verdict":"include","criteria":{"C1":"pass"},"quote":"â€¦"}
# {"source":"S002","verdict":"exclude","reason":"off-topic"}

bun $L add-evidence --batch $R/evidence.jsonl
# {"source":"S001","question":"SQ1","score":8,"summary":"â€¦","quote":"â€¦","locator":"Â§3.1","scope_note":"â€¦"}
```

Use it. Every CLI call is an agent turn that re-sends the conversation, so
bookkeeping â€” not searching â€” is where a systematic run spends its budget: 60
sources screened and eight columns extracted each is several hundred turns
one at a time, or a handful in batches. One lock, one parse, one write.

Semantics, because they matter for auditability: every line is attempted, the
lines that succeed are written, the lines that fail are named with their line
number and are **not** written. Exit 2 if any line was refused by a rule, 1 if
any line errored, 0 only when every line landed. Fix the named lines and
resubmit just those. Validation is identical to the single-record path,
including the unknown-key check â€” a typo in a batch record fails that line.

## The contract, generated

Everything below is printed by `bun $L contract --md` from the same
constants the checks read, so it cannot describe a rule the code stopped
enforcing. Do not edit it by hand: `bun $L contract --check references/ledger.md`
fails when this copy is stale, and `scripts/pipeline.test.ts` runs that check.

<!-- drp:contract v1 -->
_Generated by `ledger.ts contract --md` from the constants the checks read._

### Closed vocabularies

| Field | Allowed values |
|---|---|
| criterion `--id` | `C1`, `C2`, … — yours to assign, one series for both directions |
| criterion `--direction` | `include`, `exclude` |
| criterion / screen `--stage` | `metadata`, `abstract`, `fulltext` |
| screen `--verdict` | `include`, `exclude`, `defer` |
| screen `--reason` (mandatory on exclude) | `off-topic`, `wrong-population`, `no-method`, `outside-window`, `wrong-language`, `retracted`, `duplicate`, `not-primary`, `unobtainable`, `vendor-marketing`, `not-peer-reviewed` |
| screen `--reviewer` | `pass1`, `pass2`, `human` |
| evidence `--score` | integer 1–10 |
| claim `--consensus` | `strong`, `moderate`, `contested`, `thin`, `absent` |
| contradiction `--class` | `direct`, `scope`, `methodological`, `version-drift`, `interpretive` |
| verify `--status` | `supported`, `partial`, `unsupported`, `contradicted` |
| memory `--kind` | `preference`, `scope`, `source`, `method`, `pitfall`, `terminology` |
| mark-read `--scope` | `abstract`, `fulltext` |
| `init --mode` | `quick`, `standard`, `systematic`, `interactive` |
| `init --lang` | any ISO 639 code, optionally with a region (`en`, `vi`, `ja`, `pt-BR`) |
| `init --query-lang` | `auto`, or a comma-separated list of ISO 639 codes (`vi,de,ja,ru`) — separate from `--lang`, which is the deliverable language |
| `log-query --lang` | any ISO 639 code, optionally with a region, or `auto` |
| `gate --pass` | `scope`, `coverage`, `sufficiency`, `audit`, `memory` |

**Ids.** Scripts assign `S###` sources, `E###` evidence, `CL###` claims,
`V###` verification. You assign `C#` criteria. Report body text cites
`[S007]`. No other pattern is a real id — not `IC-01`, `CLM-001`, `EV###`,
`ev_001`, `src_001`, `FND-###`, `RQ-##`. Translate one if you meet it in an
older note. Relevance is one integer 1–10 per evidence record: no quality
float, no source tier, no confidence percentage.

### Thresholds the scripts enforce

| Rule | Value | Where | Severity |
|---|---|---|---|
| Keep an evidence record | score ≥ 6 | add-evidence | refuses below (exit 2) |
| Cite an evidence record | score ≥ 7 | audit | warns below |
| A number in a summary | must appear in its quote | add-evidence | **refuses (exit 2)** |
| A number in a summary | must appear in its quote | audit | error |
| Abstract-only evidence, `systematic` | capped at score 6 | add-evidence | caps, loudly |
| A figure backing a claim | needs a full-text source | audit | error (warn in `quick`) |
| Cached text per source | ≥ 200 chars | mark-read | refuses below |
| `strong` consensus | ≥ 3 independent sources | audit | error |
| Single-source claim | must be `thin` or `absent` | audit | error |
| Cited source | must have `read_at` | audit | error |
| Included source | needs `read_at` + a live cache file | audit | error |
| Retracted source | may not be included | audit | error |
| Claim verified `unsupported` | may not ship | audit | error |
| Claim verified `contradicted` | needs a `contradiction` record | audit | error |
| `[S###]` in the report | must exist, be included, and be read | audit --report | error |
| A figure in a paragraph | needs a citation in that paragraph | audit --report | error |
| A figure in the report | may not rest only on abstract-only sources | audit --report | error (warn in `quick`) |
| Currency line | `Evidence current as of …` or the `drp:as-of` marker | audit --report | error |
| A `drp:stats` count in the report | must match the ledger | audit --report | error |
| A `drp:stats` block | should be present at all | audit --report | warning |
| `graph.json` `ledger_ids` | must exist, be included, be read | audit | error |
| `graph.json` edge endpoint | must be a node in the same file | audit | error |
| `graph.json` node or edge | should carry `ledger_ids` | audit | warning |
| Gate `scope` before evidence exists | record it with `gate --pass` | audit | warning (error in `systematic`) |
| Gates `coverage` / `sufficiency` | recorded before delivery | audit --report | warning (error in `systematic`) |
| Excluded as `unobtainable` | ≥ 15% of screened (and ≥ 3) | audit | warning |
| Included but abstract-only | ≥ 50% of included | audit | warning |
| `strong`/`moderate` claim | sources should not share authors or venue | audit | warning |
| Criterion id | may not be re-registered | add-criterion | refuses |
| An unknown flag or batch key | rejected with a suggestion | every command | refuses, writes nothing |
| A `--dir` that is a stringified object or an unexpanded variable | rejected before any write | every command | refuses, writes nothing |

### Run directory

Filenames are exact and case-sensitive.

| File | Holds |
|---|---|
| `00-brief.md` | question, framing, criteria, perspectives |
| `01-plan.md` | outline, sub-queries, routes, targets |
| `02-search-log.md` | every query: source, hits, kept |
| `03-screening.md` | include/exclude decisions + PRISMA funnel |
| `03-extraction.md` | extraction matrix (ledger.ts matrix) |
| `04-synthesis.md` | perspectives, debate, findings, contradictions |
| `05-verification.md` | CoVe questions, Reflexion changes |
| `06-knowledge-graph.md` | entity-relation map, structural gaps |
| `graph.json` | nodes + edges, ledger_ids on each (audit checks them) |
| `07-refine-log.md` | Self-Refine iterations, score history |
| `REPORT.md` | the deliverable, fully cited (uppercase, case-sensitive) |
| `gaps.md` | open questions, what to research next |
| `08-audit.md` | stats + audit output, shown to the user |
| `references-list.md` | bibliography (ledger.ts bib) |
| `stats.json` | counts (ledger.ts stats --json) |
| `ledger.json` | single source of truth — only ledger.ts writes it |
| `raw/` | executor JSON returns, merged via add-source --file |
| `sources/S###.md` | cached source text — required before a source is citable |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | error, or audit findings |
| 2 | **refused by design** — the rule is not a bug to retry around |
| 3 | `scholar.ts fetch` found no full text (a fact about the source, not a failure) |

### Environment

| Variable | Effect |
|---|---|
| `DRP_RUN_DIR` | default for `--dir` — set it once per run |
| `DRP_CACHE_DIR` | relocate the shared cross-run source cache |
| `OPENALEX_API_KEY` | 10× daily budget, usage tracking |
| `SEMANTIC_SCHOLAR_API_KEY` | strongly recommended; the keyless tier returns 429 under real load |
| `RESEARCH_CONTACT` | an email, sent to Crossref and Unpaywall as etiquette; required for `fetch`'s Unpaywall route |

### Language-neutral markers

`audit --report` reads English and Vietnamese headings natively. In any
other output language, mark the two places it looks for:

```markdown
<!-- drp:as-of 2026-09-03 -->     <!-- the currency line -->
<!-- drp:references -->                     <!-- start of the reference list -->
```
<!-- /drp:contract -->

Never echo a key value into logs, the search log, or a deliverable.
`doctor` reports each key as set or not set and never prints one.
## Schema

`ledger.ts init` creates this shape.

```jsonc
{
  "version": 1,
  "topic": "â€¦", "mode": "standard", "lang": "en", "queryLangs": ["auto"],
  "created": "â€¦", "updated": "â€¦",
  "criteria":      [{ "id": "C1", "direction": "include", "text": "â€¦", "stage": "abstract" }],
  "sources":       [{ "id": "S001", "title": "â€¦", "authors": ["â€¦"], "year": 2024,
                      "venue": "â€¦", "doi": "â€¦", "url": "â€¦", "oa_url": "â€¦", "abstract": "â€¦",
                      "kind": "article", "retracted": false, "anomalies": [],
                      "interest_disclosure": "unclear", "found_by": ["â€¦"],
                      "metadata_at": "YYYY-MM-DD",   // API returned it â€” not citable
                      "read_at": "YYYY-MM-DD",       // mark-read only â€” citable
                      "read_scope": "abstract|fulltext", "cache_chars": 4210 }],
  "screening":     [{ "source": "S001", "stage": "abstract", "verdict": "include",
                      "reason": null, "criteria": { "C1": "pass" }, "quote": "â€¦",
                      "confidence": "high", "reviewer": "pass1" }],
  "evidence":      [{ "id": "E001", "source": "S001", "question": "SQ1", "summary": "â€¦",
                      "quote": "â€¦", "locator": "Â§5.2", "score": 8, "scope_note": "â€¦",
                      "from_scope": "abstract|fulltext" }],   // the source's reading scope at record time
  "extraction":    [{ "source": "S001", "column": "n", "value": "1,204", "quote": "â€¦", "locator": "Â§3.1" }],
  "claims":        [{ "id": "CL001", "text": "â€¦", "evidence": ["E001"], "consensus": "strong" }],
  "contradictions":[{ "a": "E001", "b": "E002", "class": "direct", "note": "â€¦" }],
  "verification":  [{ "id": "V001", "claim": "CL001", "question": "â€¦", "answer": "â€¦",
                      "status": "supported", "evidence": ["E001"], "note": "â€¦" }],
  "queries":       [{ "q": "â€¦", "source": "web", "hits": 20, "kept": 3, "lang": "vi", "at": "â€¦" }],
  "gates":         [{ "gate": "scope", "at": "â€¦", "note": "user approved the brief" }]
}
```

Every record also carries `at`. PRISMA counts, dual-review agreement,
saturation and funnel numbers are **derived by `stats`** â€” they are not
stored, so there is nothing to keep in sync. Run position is likewise derived,
by `state`.

Three things live outside the ledger on purpose: `graph.json` (stage 6 â€”
derived analysis, regenerable, though `audit` checks its `ledger_ids` against
the ledger), the cached source text under
`$R/sources/S###.md`, which is what keeps a quote checkable after the page
changes or dies, and the shared cross-run cache at the skill root, which only
ever saves a fetch (`ledger.ts cache`, `DRP_CACHE_DIR` to relocate). A cache
hit is still copied into `$R/sources/` â€” the run must stay auditable after the
cache is pruned.

## The citable path

Four commands, in this order, per source. Skipping the second is the most
common way a run fails its audit.

```bash
bun $L add-source --dir $R --file hits.json --from openalex   # metadata_at
bun $L mark-read  --dir $R --source S001 --from-abstract      # read_at + cache file
bun $L screen     --dir $R --source S001 --verdict include --criteria "C1:pass"
bun $L add-evidence --dir $R --source S001 --question SQ1 --score 8 \
       --summary "â€¦" --quote "â€¦" --locator "Â§3.1" --scope-note "â€¦"
```

`--from-abstract` writes `$R/sources/S001.md` from the abstract the ledger
already holds â€” legitimate when the abstract is your evidence, but it caps what
that evidence can support: a number needs the full text (non-negotiable 13).
`mark-read --all-from-abstract` does that for every unread source in one call
and names the ones whose abstract is too short to cache, which are your
`unobtainable` candidates. The full-text path is one extra command:

```bash
bun $S fetch     --id 10.1371/journal.pone.0266781 --out $R/sources/S001.md
bun $L mark-read --dir $R --source S001 --scope fulltext
```

`fetch` exits 3 when no OA full text exists. Then either read the page with
`<fetch>` and write `$R/sources/S001.md` yourself, or fall back to the
abstract and keep numbers out of the evidence.

## Rendering

`matrix`, `bib` and `stats` print to stdout. Redirect them:

```bash
bun $L matrix --dir $R > $R/03-extraction.md
bun $L bib    --dir $R > $R/references-list.md
bun $L stats  --dir $R > $R/08-audit.md
bun $L audit  --dir $R --report >> $R/08-audit.md
bun $L stats  --dir $R --md              # the block to paste into REPORT.md
```

The `stats --md` block goes into the deliverable verbatim, markers included.
`audit --report` finds it, recomputes every number from the ledger, and errors
on any that changed â€” so the counting rule is enforced rather than promised. A
report with no block gets a warning; the block's own numbers are not read as
uncited figures.

## When you change a script

Two suites, both through the CLI â€” exit codes included, since those are the
contract. Neither touches the network, and each test gets its own temp
directories.

```bash
bun test scripts/          # both suites
```

`ledger.test.ts` holds each rule still one command at a time.
`pipeline.test.ts` runs a whole nine-stage run and asserts it ends with
`audit --report` exiting 0 â€” the integration bugs live between commands, not
inside them â€” and it is what fails when the generated contract above drifts
from the scripts. Run both after touching `ledger.ts`, `args.ts`,
`cache.ts`, or an audit rule; add a case when you add a rule; and if you
changed a vocabulary or a threshold, regenerate this file's contract block with
`bun $L contract --md`.
