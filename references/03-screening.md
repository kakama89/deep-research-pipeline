# Stage 3 — Screening (Elicit + ASReview)

> **Wiring** · `ledger.ts screen` (one record per source, `--reason`
> mandatory on exclude), then `ledger.ts add-evidence` for relevance-scored
> passages. Every count comes from `ledger.ts stats` — never hand-count,
> never store a count, **never hand-edit `ledger.json`.** Depth:
> `references/screening-extraction.md` (matrix columns, dual-pass, PRISMA
> rendering) and `references/evidence-synthesis.md` (PaperQA2 scoring).
> Criterion *wording* is owned by `references/scoping-criteria.md`; this file
> owns *applying* the criteria.

**Precondition.** `add-evidence` warns and the audit errors when a source has
no `read_at` — screening a source does not make it citable, `mark-read` does.
Fix that in stage 2 rather than here.

**Use `--batch`.** `screen`, `add-evidence`, `extract` and `claim` all take
`--batch f.jsonl`. This stage decides a run's turn cost: 60 sources screened
and 8 columns extracted is several hundred agent turns one at a time, or a
handful in batches.

**Leaving this stage** — `ledger.ts state` holds it open until: nothing is
awaiting screening, at least one evidence record exists, `03-screening.md`
exists, the extraction matrix is non-empty (except in `quick`), and
`gate --pass sufficiency` is recorded.

Set `$L` and `$R` once (see `references/ledger.md`); run `bun $L --help` for
the command list — a flag not in `--help` does not exist.

```bash
L="$SKILL/scripts/ledger.ts"
R="research/<YYYYMMDD>-<slug>"
```

## The four-command citable path

Every source that ends up cited travels the same four commands, in this
order (from `references/ledger.md`). Skipping the second is the most common
way a run fails its audit.

```bash
bun $L add-source   --dir $R --file hits.json --from openalex        # metadata_at only — not citable yet
bun $L mark-read    --dir $R --source S001 --from-abstract           # sets read_at + writes sources/S001.md
bun $L screen       --dir $R --source S001 --stage abstract \
       --verdict include --criteria "C1:pass,C2:pass"
bun $L add-evidence --dir $R --source S001 --question SQ1 --score 8 \
       --summary "…" --quote "…" --locator "§3.1" --scope-note "…"
```

`add-evidence` **refuses any score below 6** — discard weak passages, do not
hoard them. Cite only at score ≥ 7 (`audit` warns below). It also **refuses
(exit 2) any number in the summary that its quote does not contain**, and it
stamps the source's reading scope on the record: a figure taken from an
abstract-only source cannot back a claim outside `quick` mode, and in
`systematic` mode such a record is capped at 6. When a number matters, get the
full text first — `bun $S fetch --id <doi> --out $R/sources/S001.md`, then
`mark-read --scope fulltext`.

**Screen and record in batches.** This stage is where a run's turn cost is
decided: 40 sources screened, 80 evidence records, and a column per included
source is several hundred CLI calls one at a time. `screen`, `add-evidence`,
`extract`, `claim` and `verify` take `--batch file.jsonl` — one JSON object per
line, keys named like the flags without the dashes — and apply the lot under one
lock. The rules are identical; a line that breaks one is named by line number,
is not written, and the call exits 2 (refusal) or 1 (error) so you resubmit only
that line.

```bash
bun $L screen --dir $R --batch $R/screen.jsonl
# {"source":"S001","verdict":"include","stage":"abstract","criteria":{"C1":"pass","C2":"pass"}}
# {"source":"S002","verdict":"exclude","reason":"wrong-population","quote":"…"}
```

## What this stage does

Stage 3 turns the raw Stage-2 corpus into a curated included set with a
documented rationale per decision. It fuses **Elicit-style screening**
(pre-registered criteria per source, each decision recorded with a verdict,
a reason on exclude, and a quote) with **ASReview-style prioritisation**
(screen the highest-value sources first, re-rank as you learn, stop when new
relevance dries up). Outputs: `03-screening.md` and `03-extraction.md`
(rendered by `ledger.ts matrix`); all PRISMA counts are **derived** by
`stats`.

## 3.1 Applying the pre-registered criteria

The criteria were registered in Stage 1 with `ledger.ts add-criterion`
before any search ran. Do not invent or reword criteria here — a criterion
that was not pre-registered means you are fitting criteria to the sources
you happened to find. Criterion *wording* belongs to
`references/scoping-criteria.md`; this file applies them.

Criteria are one series — `C1`, `C2`, `C3`, … — with `include`/`exclude` as
a **field** on each, not an id prefix. There is no `IC-`/`EC-` split. On a
screen record each criterion carries a value in `--criteria`, e.g.
`"C1:pass,C2:fail,C5:defer"`.

Amending a criterion mid-review is a protocol amendment: it must be visible
(`add-criterion` refuses to silently overwrite an id), recorded with its
reason, and any affected sources rescreened. Undisclosed mid-review changes
are the single most common way a review misleads — report them prominently;
empty is the good answer.

### Two-stage calibration

**Abstract stage — soft (high recall).** Admit a source unless it
*explicitly* fails a criterion. Abstracts routinely omit sample size, method,
or population that the full text states plainly, so a criterion you cannot
decide from the abstract is `defer`, not `fail` — excluding on absence here
silently deletes good papers that never come back.

**Full-text stage — strict (high precision).** Only sources that passed the
abstract stage. Demand explicit evidence for every criterion, including the
deferred ones. Here silence *is* informative: a paper that never reports its
sample size has told you something about its rigour.

The `screen` verdict is `include`, `exclude`, or `defer`; per-criterion
values inside `--criteria` are `pass`, `fail`, or `defer`. A genuinely
ambiguous abstract is `defer` (needs full text), never `fail`.

## 3.2 Active-learning screening order

Do not screen in arbitrary order (alphabetical, chronological). Prioritise
the sources most likely to be relevant so key findings surface early and you
can stop with confidence. No ML library is involved — this is the agent
recognising what relevant sources look like and re-ranking as it learns.

1. **Seed.** Screen 5–10 sources by hand first, chosen to span the corpus
   (a few of the most-cited hits, a few from different sub-topics, a few
   borderline). This calibrates what "relevant" looks like for this topic.
2. **Rank.** Order the remaining sources by how closely their title and
   abstract resemble the ones you just included — shared concepts, methods,
   populations, venues — and how clearly they lack the excluded ones' signals.
3. **Screen top-down**, most promising first.
4. **Re-rank after each batch.** Every 10–20 sources, revise your sense of
   "relevant" from what you just decided, then re-order the queue.

### Stop rules (prose, not maths)

Stop when any of these holds, and document which: new relevant sources have
dried up (roughly 20 excludes in a row); the top of the re-ranked queue is
clearly off-topic; or every source has been screened. When you stop before
the corpus is exhausted, record how many sources went unscreened, why you
judged the remainder unlikely to be relevant, and the resulting limitation.
That estimate is a judgement — state it as one.

## 3.3 The per-source decision record

One `screen` record per source per stage. The fields are exactly those the
schema holds (`references/ledger.md`): `source`, `stage`
(`metadata`/`abstract`/`fulltext`), `verdict` (`include`/`exclude`/`defer`),
`reason` (null unless excluding), `criteria` (the pass/fail/defer map),
`quote`, `confidence`, `reviewer` (`pass1`/`pass2`/`human`). There is no
stored classifier version, priority rank, or predicted-relevance field —
those live in your working order, not in the ledger.

A human-readable record for the deliverable:

```markdown
### S014 — "Title" (2024)
| Criterion | Verdict | Basis |
|-----------|---------|-------|
| C1 empirical result | pass  | "we evaluate on 3 datasets" |
| C2 year in window   | pass  | 2024 |
| C3 not opinion      | pass  | method section described |
| C4 not retracted    | pass  | retracted:false |
| C5 sample size      | defer | not in abstract — full-text stage |
**Verdict**: include   **Confidence**: high
```

This is written by the `screen` command shown in the four-command path,
passing every criterion its `pass`/`fail`/`defer` value in `--criteria`.

## 3.4 Exclusions and their reasons

`--reason` is mandatory on `exclude` and must be one of eleven closed values —
anything else throws: `off-topic`, `wrong-population`, `no-method`,
`outside-window`, `wrong-language`, `retracted`, `duplicate`, `not-primary`,
`unobtainable`, `vendor-marketing`, `not-peer-reviewed`.

These are the only legal reasons. An exclusion phrased as a criterion id
(`EC-01`) or as "criterion not met" (`IC-03_not_met`) is not a real reason —
translate it to the closed value that fits:

| Situation | Reason |
|---|---|
| Editorial/opinion, no original data | `not-primary` |
| Before the window's start year | `outside-window` |
| No method described / addresses no sub-question | `no-method` |
| Superseded by a fuller publication of the same data | `duplicate` |
| Population outside scope | `wrong-population` |
| Full text only in a non-protocol language | `wrong-language` |
| Retracted | `retracted` |
| Full text unobtainable | `unobtainable` |
| Vendor collateral, not an independent study | `vendor-marketing` |
| Preprint, blog, thesis or news, under `--evidence-tier verified` | `not-peer-reviewed` |
| Off the topic entirely | `off-topic` |

```bash
bun $L screen --dir $R --source S003 --stage abstract \
  --verdict exclude --reason not-primary \
  --quote "This editorial argues that…" --confidence high
```

Reasons aggregate because the set is closed — "excluded 41: 18 off-topic,
11 no-method, 7 outside-window, 3 retracted, 2 unobtainable" is reviewable;
"excluded the irrelevant ones" is not.

### Defer handling

`defer` means the abstract cannot settle it, so the source goes to the
full-text stage and is screened again at `--stage fulltext` under strict
calibration, where the previously deferred criteria must be decided on
explicit evidence.

## 3.5 Dual-pass review (`systematic` mode)

Single-pass screening drifts: as you screen 60 papers your reading of C1
shifts, and the last 20 are judged differently from the first. A second pass
catches it — but only if it is genuinely independent.

- Delegate pass 2 to a fresh general-purpose `<subagent>`. Give it the criteria
  and the abstracts, **not** your verdicts — priming it produces agreement,
  not review. Record it with `--reviewer pass2`.
- `stats` reports the agreement rate and lists the conflicts.

```bash
bun $L screen --dir $R --source S014 --stage abstract \
  --reviewer pass2 --verdict exclude --reason no-method
bun $L stats  --dir $R      # agreement rate + conflict list
```

**Below ~80% agreement the criteria are underspecified.** Stop, sharpen the
wording with the user (in `scoping-criteria.md` terms), and rescreen. Do not
resolve disagreements yourself — a disagreement means the criterion was
ambiguous and the user owns that call. Present each source, the criterion,
and both readings.

## 3.6 The PRISMA funnel comes from `stats`

Every funnel number is derived from the screen records by `stats`. There is
no stored `prisma_counts` object, no `active_learning` block, no
`decisions[]` array to keep in sync — the ledger holds the raw screen
records and `stats` recomputes the funnel each time, so it cannot drift.

```bash
bun $L stats --dir $R           # human-readable funnel + exclusion breakdown
bun $L stats --dir $R --json    # same numbers, machine-readable
```

- ✅ read the funnel out of `stats --json` and quote that number
- ❌ estimate ("roughly 60–70 passed abstract screening")
- ❌ count decision records by hand
- ❌ read a `prisma_counts` field out of `ledger.json` — no such field exists

The funnel's internal consistency (identified = deduped + duplicates;
eligible = included + excluded + deferred; and so on) is checked by
`bun $L audit --dir $R`, which must exit 0 before delivery — you do not
compute those identities by hand.

## 3.7 Evidence, extraction, and thin coverage

For each research question, summarise the relevant passages *relative to the
question* and score relevance 1–10 with `add-evidence`. Keep ≥ 6 (the
command refuses below), cite ≥ 7. A number in a summary that is absent from
its quote is an audit error.

**Citation traversal when evidence is thin.** If a question has too little
evidence after screening the corpus, do not pad it with weak passages or
background knowledge. Traverse citations — follow the reference lists and
citing papers of your strongest included sources through `scholar.ts cites`
— to find primary sources, add them via the four-command path, and screen
them. If it is still thin, say so and route the gap to `gaps.md`; refuse
rather than guess.

The **extraction matrix** (columns, cell quotes/locators, provenance) is
owned by `references/screening-extraction.md`, rendered with
`ledger.ts matrix > $R/03-extraction.md`. Do not duplicate the column set
here — see that file.

## 3.8 The sufficiency gate

Stage 3 ends at the sufficiency gate (SKILL.md gate 3). Present, per
research question, which have solid evidence and which are thin, with the
counts from `stats`, and offer the user the choice: write now, or search
deeper on the thin questions (usually via the citation traversal above). Do
not advance to synthesis until the user decides.

## Stage 3 completion checklist

- [ ] Criteria pre-registered in Stage 1; any amendment recorded and affected sources rescreened
- [ ] Sources screened in relevance order; every early stop documented; every source has a `screen` record
- [ ] Every exclude carries one of the eleven closed reasons and a quote; deferred sources rescreened at full text
- [ ] Dual-pass agreement recorded (`systematic`); below ~80% the criteria were sharpened, conflicts taken to the user
- [ ] Evidence scored with `add-evidence` (≥ 6 kept, ≥ 7 citable); thin questions traversed or routed to `gaps.md`
- [ ] Funnel numbers from `stats`, never hand-counted; sufficiency gate presented before synthesis
