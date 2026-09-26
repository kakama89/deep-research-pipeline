# Stage 3 depth — Screening and Structured Extraction

This is **Elicit's** contribution to Stage 3 (both screening and the
extraction matrix; see the stage map in `references/ledger.md`). Two ideas
carry the weight:

1. **Screening decisions are records, not judgements.** Each source gets
   a per-criterion verdict with a supporting quote and an exclusion
   reason. That is what makes a search reviewable and repeatable.
2. **Extraction is a matrix, not a summary.** Rows are papers, columns
   are questions, and every cell carries a quote and a locator. A cell
   without a quote is an inference, and inferences must be visibly
   labelled as such.

Both stages exist to stop the same failure: a report that reads well
because it quietly dropped the sources that disagreed and rounded the
numbers it half-remembered.

## 4.1 The screening funnel

Four steps, and every transition is counted:

```
identified  ──dedup──>  unique  ──abstract screen──>  eligible  ──full-text screen──>  included
```

Every number comes from the tool, never from counting by hand:

```bash
bun $SKILL/scripts/ledger.ts stats --dir research/<slug>
```

Exclusions must carry a reason, and the reasons must aggregate. "Excluded
41: 18 off-topic, 11 no method, 7 outside time window, 3 retracted,
2 full text unobtainable" is reviewable. "Excluded the irrelevant ones"
is not.

## 4.2 Abstract-stage screening

Apply the criteria registered in stage 1. Nothing new gets invented here
— if a criterion was not pre-registered, you are fitting the criteria to
the sources you found, which is how a review ends up confirming whatever
the search happened to return.

**Calibration: soft.** Admit a source unless it *explicitly* fails a
criterion. Abstracts routinely omit the sample size, the method detail,
or the population that the full text states plainly. Excluding on absence
at this stage silently deletes good papers, and they never come back.

Per source, produce a record:

```markdown
### S014 — "Title" (2024)
| Criterion | Verdict | Basis |
|-----------|---------|-------|
| C1 empirical result | pass | "we evaluate on 3 datasets" |
| C2 year/citations | pass | 2024 |
| C3 not opinion | pass | method section described |
| C4 not retracted | pass | retracted:false |
| C5 sample size | defer | not in abstract — full-text stage |
**Verdict**: eligible   **Confidence**: high
```

Verdicts: `pass`, `fail`, `defer` (needs full text), `unclear` (abstract
is genuinely ambiguous — treat as `defer`, not as `fail`).

```bash
bun $SKILL/scripts/ledger.ts screen \
  --dir research/<slug> --source S014 --stage abstract \
  --verdict include --criteria "C1:pass,C2:pass,C3:pass,C4:pass,C5:defer" \
  --quote "we evaluate on 3 datasets" --confidence high
```

Exclusion needs `--reason` with one of a fixed vocabulary, so reasons can
be aggregated: `off-topic`, `wrong-population`, `no-method`,
`outside-window`, `wrong-language`, `retracted`, `duplicate`, `not-peer-reviewed`,
`not-primary`, `unobtainable`, `vendor-marketing`.

## 4.3 Full-text screening

Only sources that passed the abstract stage. Fetch the full text — OA URL
from OpenAlex, Unpaywall for a DOI, Europe PMC for biomed, arXiv for
preprints. If you cannot obtain it, exclude as `unobtainable` and record
the attempts. An unobtainable paper is a limitation to report, not a
paper to guess about.

**Calibration: strict.** Now demand explicit evidence for every
criterion, including the deferred ones. At this stage silence *is*
informative: a paper that never reports its sample size has told you
something about its rigour.

## 4.4 Dual review (`systematic` mode)

Single-pass screening drifts. As you screen 60 papers your interpretation
of C1 shifts, and the last 20 are judged differently from the first 20.

Second pass, and it must be genuinely independent:

- Delegate pass 2 to a fresh general-purpose `<subagent>`. Give it
  the criteria and the abstracts, and **not** your verdicts. Priming it
  with your decisions produces agreement, not review.
- Compare verdict by verdict. Record agreement rate.
- **Disagreements go to the user.** Do not resolve them yourself; a
  disagreement means the criterion was ambiguous, and the user owns that
  call. Present the source, the criterion, and both readings.

```bash
bun $SKILL/scripts/ledger.ts screen \
  --dir research/<slug> --source S014 --reviewer pass2 --verdict exclude \
  --reason no-method --stage abstract
bun $SKILL/scripts/ledger.ts stats --dir research/<slug>
# reports agreement rate and lists conflicts
```

An agreement rate below ~80% means the criteria are underspecified. Stop,
sharpen them with the user, and rescreen. Continuing produces a review
whose inclusion set is arbitrary.

## 4.5 Deliverable: `03-screening.md`

```markdown
# Screening — <topic>
**Criteria version**: as pre-registered in 00-brief.md, unamended
**Calibration**: soft at abstract, strict at full text
**Reviewers**: pass1 (primary), pass2 (independent subagent)

## Funnel
| Step | Count |
|------|-------|
| Identified across all sources | 128 |
| Unique after dedup | 94 |
| Excluded at abstract | 41 |
| Eligible for full text | 53 |
| Full text unobtainable | 4 |
| Excluded at full text | 12 |
| **Included** | **37** |
<all numbers from `ledger.ts stats`>

## Exclusions by reason
off-topic 18 · no-method 11 · outside-window 7 · retracted 3 · unobtainable 4 · vendor-marketing 6 · not-primary 4 · not-peer-reviewed 9

## Dual review
Agreement 87% (82/94). 12 conflicts, all resolved by the user on <date>.
Conflicts and their resolutions: <table>

## Per-source decisions
<one record per source, as in 4.2>

## Amendments
<any criterion changed mid-review, when, why, and which sources were
rescreened. Empty is the good answer.>
```

If a criterion *was* amended mid-review, say so prominently. Undisclosed
mid-review criteria changes are the single most common way a literature
review misleads.

## 4.6 The extraction matrix

Rows are included sources. Columns are questions — one column per thing
you need from every paper, derived from the sub-questions in
`00-brief.md`.

Column design rules:

- **One fact per column.** "Method and sample size" is two columns.
- **Name the expected shape.** `sample_size` expects a number,
  `population` a phrase, `effect_direction` one of
  positive/negative/null/mixed. Consistent shape is what makes the
  column comparable across rows.
- **Add a `quote` and `locator` to every cell.** No exceptions.
- **`not reported` is a real value**, and a common one. Never leave a
  cell blank and never infer a value silently. If you must infer, mark
  the cell `inferred:` and say from what.
- **Include a provenance column** for who published the work and whether
  they had an interest in the result.

A workable default column set, adapt per domain:

| Column | Shape | Notes |
|--------|-------|-------|
| `population` | phrase | What or who was studied |
| `n` | number or `not reported` | Sample size |
| `method` | phrase | Design, not results |
| `intervention` | phrase | What was done or compared |
| `comparator` | phrase | Against what baseline |
| `primary_outcome` | phrase | As the authors defined it |
| `result` | number + unit | The headline finding, quoted |
| `effect_direction` | enum | positive / negative / null / mixed |
| `limitations_stated` | phrase | What the authors themselves flagged |
| `funding_interest` | enum | independent / industry / unclear |

```bash
bun $SKILL/scripts/ledger.ts extract \
  --dir research/<slug> --source S014 --col n --value "1,204" \
  --quote "our final cohort comprised 1,204 participants" --locator "§3.1"

bun $SKILL/scripts/ledger.ts matrix \
  --dir research/<slug> > research/<slug>/03-extraction.md
```

`matrix` renders from the ledger, so the table and the underlying records
cannot drift apart.

## 4.7 Reading the matrix

The matrix is not just a record; it is where several findings become
visible that prose synthesis hides:

- **A column that is mostly `not reported`** is a finding about the
  field's reporting standards. Say so in the report.
- **Clustered `effect_direction`** shows consensus at a glance. Mixed
  directions are your contradiction candidates — hand them to
  `references/evidence-synthesis.md`.
- **`funding_interest` correlated with `effect_direction`** is the
  single most important pattern to check, and it is invisible without
  the matrix. Check it explicitly, every time.
- **Wildly varying `n`** means findings are not equally weighted. A
  result from n=12 and one from n=12,000 do not get equal billing.
- **Every row sharing one comparator** means the field has a blind spot.
  That belongs in `gaps.md`.

Run each of these checks and record the outcome, including "checked, no
pattern found". A check you did not report is a check the reader assumes
you skipped.
