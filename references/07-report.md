# Stage 7 — Writing the Report (Self-Refine)

> **Wiring** · Tools: `ledger.ts bib --dir $R` renders the reference list and
> `ledger.ts stats --dir $R` produces every number in the method section and
> the PRISMA funnel. Self-Refine critiques prose quality — it does not license
> new claims. Any claim added during a refine pass needs a `ledger.ts claim`
> record and a stage 5 `verify` pass before it can stay.

**Leaving this stage** — `ledger.ts state` holds it open until `REPORT.md`
(uppercase) and `gaps.md` exist. Four things `audit --report` errors on, all
cheaper to get right while writing than to retrofit:

- a `[S###]` that is unknown, excluded, or unread;
- a paragraph stating a figure with no citation in that same paragraph;
- no `Evidence current as of <date>` line (or `<!-- drp:as-of YYYY-MM-DD -->`
  in an output language the audit does not read);
- a `stats --md` counts block whose numbers were edited by hand — paste it
  verbatim, markers included, and let the tool own the funnel.

**STORM's** writing discipline: the outline comes first, each section is
written independently against its own evidence, and only then does a coherence
pass run over the whole document. Writing straight through from the top
produces a report that drifts, repeats itself, and cites whatever was most
recently in context.

**GPT Researcher's** publishing discipline: the report is an aggregation of
source-attributed findings, not an essay that happens to have footnotes. If a
sentence has no ledger id, it is either a signposting sentence or it does not
belong.

Inputs come from the outline (stage 1), verified claims (stage 5 verification),
graph insights (stage 6), and the ledger (quotes, metadata, counts). The output
is `REPORT.md` plus `gaps.md` — the deliverable the user sees.

## 7.1 Order of operations

1. **Render the mechanical parts from the ledger first** — bibliography,
   extraction matrix, funnel counts. They are inputs to the prose, and
   generating them first stops you from writing a number the ledger disagrees
   with.
   ```bash
   L="$SKILL/scripts/ledger.ts"
   R="research/<slug>"
   bun $L bib    --dir $R        > $R/references-list.md
   bun $L matrix --dir $R        > $R/03-extraction.md
   bun $L stats  --dir $R --json > $R/stats.json
   bun $L stats  --dir $R --md                # the counts block REPORT.md carries
   ```
   Keep these inside the research directory, not in a system temp path. Paste
   the `stats --md` block into the method section unedited, markers included:
   `audit --report` recomputes every number in it from the ledger and errors on
   any that changed, which is how the counting rule stops being an honour system.
2. **Write section by section, in outline order.** For each section load only
   the evidence records tagged to its sub-question. Cite as you write; never
   leave citations to a later pass, because by then you will not remember which
   record carried which number.
3. **Self-Refine loop** (7.5): draft → critique against the rubric → revise
   affected sections → re-score, until the rubric passes or the mode's pass
   budget is spent.
4. **Coherence pass** (7.6) over the assembled draft.
5. **Audit** — stage 8, `references/08-quality-gates.md`. Non-optional.

## 7.2 Citation format

In the body, cite ledger ids in square brackets: `[S014]`, or `[S014, S022]`
for several. For a specific number, add the locator: `34 ms median [S014 §5.2]`.

The reference list resolves every id, and every entry carries an access date
because online sources change:

```markdown
## References

[S014] Nguyen, T., Park, J., & Alvarez, M. (2024). *Reranking latency in
production retrieval systems*. Proceedings of SIGIR 2024, 812-823.
DOI: [10.1145/3626772.3657891](https://doi.org/10.1145/3626772.3657891).
Open access: [PDF](https://…). Accessed 2026-08-19. *Independent.*

[S022] Acme Inc. (2026). *Vector search benchmark report*.
<https://acme.example/benchmark>. Accessed 2026-08-19.
**Vendor-published — Acme sells the product benchmarked.**

[S031] Okonkwo, A., et al. (2025). *Preprint: A replication of …*.
arXiv:2503.04412. Accessed 2026-08-19. **Preprint, not peer reviewed.**
```

Generate the list with the tool; never hand-format ids:

```bash
bun $SKILL/scripts/ledger.ts bib --dir research/<slug>
```

Three labels are mandatory wherever they apply, in the reference list and at
first mention in the body: **vendor-published / sponsored**, **preprint**, and
**retracted**. A reader who does not know a benchmark came from the vendor
selling the product has been misled, however accurate the number is. More than
three authors: first three + "et al.". Year unknown: "n.d.".

## 7.3 REPORT.md — `standard` mode

Every report follows this structure. The **`Evidence current as of <date>`**
line is mandatory — `audit --report` errors with `no-currency-line` without it.
`REPORT.md` is uppercase and case-sensitive; stage 8 reads that exact name.

```markdown
# <Title: the question, answered in a phrase>

**Question**: <primary question from 00-brief.md>
**Evidence base**: <n> sources included of <n> screened; <n> evidence
records; <n> at relevance 7+. Counts from `ledger.ts stats`.
**Evidence current as of**: <date>
**Method**: deep-research-pipeline, `standard` mode. Search log in
`02-search-log.md`, screening in `03-screening.md`, ledger in `ledger.json`.

## Summary

<5-8 sentences. The answer to the primary question, with the strongest
citations inline and consensus labels where a claim is not solid. A reader who
stops here should have the answer, not a description of what the report covers.>

**Confidence**: <strong / moderate / mixed> — <one sentence on why>

## Key findings

1. **<Finding as an assertion, not a topic>** [S007, S014, S022]
   *Consensus: strong.* <2-3 sentences of substance with the numbers and their
   conditions.>
2. **<Finding>** [S031] *Consensus: thin — one study, n=40.*
   <Stated as narrowly as the evidence allows.>

## <Outline section 1>
<Prose. Every claim cited. Scope conditions stated alongside numbers, not in a
footnote.>

## <Outline section n>

## Contradictions and disagreements
<From 04-synthesis.md. Both sides, the classification, and your assessment of
which is better supported and why. Never a split-the-difference number.>

| Contested point | Position A | Position B | Assessment |
|-----------------|------------|------------|------------|
| <what> | <position> [S001] | <position> [S007] | <which is better supported and why> |

## What the evidence does not cover
<The refusal blocks. Each names what is missing and what would settle it.
Cross-reference gaps.md.>

## Limitations of this review
- Languages searched: <list>. <What that likely misses.>
- Databases: <list>. <What is not in them.>
- Time window: <window>. <What that excludes.>
- Screening: single-pass / dual-pass, agreement <n>%.
- <n> full texts unobtainable; they are listed in 03-screening.md.
- Publication bias: <assessment>.
- Vendor-sourced share: <n> of <n> included sources.

## Analyst assessment (not sourced)
<Optional, clearly fenced. Inference and judgement that no source supports.
Omit the section entirely rather than padding it.>

## References
<from `ledger.ts bib`>
```

Consensus labels in the body and key findings are exactly the five the ledger
validates: **`strong` / `moderate` / `contested` / `thin` / `absent`**. No
other taxonomy (no High/Medium/Low) is a real label; `audit` and `claim`
reject anything else.

## 7.4 Mode variants

**`quick` — brief, ~600-900 words.** Summary, 3-5 key findings, gaps,
references. Drop the per-section prose and the extraction matrix. Keep
citations, dates, the currency line, and the limitations block — a quick report
is allowed to be short, not allowed to be unsourced. State prominently that it
is a scan, not a review.

**`systematic` — review-grade.** Add after Summary:

```markdown
## Protocol
Question and framing, pre-registered criteria (verbatim from 00-brief.md),
databases and dates searched, full query strings, screening calibration,
extraction columns. Protocol amendments with dates and reasons — or "none".

## Search and selection
<the PRISMA-style funnel table from 03-screening.md, plus exclusions by reason,
plus the saturation test results from 02-search-log.md>

## Included studies
<the extraction matrix, or a pointer to 03-extraction.md if wide>

## Risk of bias
<per included source: funding interest, preregistration, sample size, whether
the primary outcome was defined in advance. Then the corpus-level pattern —
does funding correlate with direction?>

## Synthesis
<narrative by outcome. Do not pool numbers across incommensurable methods; if
the studies are not comparable, say so and report them separately.>
```

**`interactive` — running summary plus final report.** Maintain the mind map
(`01-plan.md`) through the session; at close, write the standard report and add
a section on what the roundtable surfaced that the original framing missed.
That section is the specific value of Co-STORM mode and should not be omitted.

## 7.5 Self-Refine loop and rubric

Self-Refine is `generate → critique → revise → (repeat)`. Each pass targets
specific weaknesses named in the critique, not a vague polish.

**Passes by mode** (SKILL.md is authoritative):

| Mode | Self-Refine passes |
|------|--------------------|
| `quick` | 1 — best achievable in a single pass |
| `standard` | 1 |
| `systematic` | 3 — review-grade, all dimensions ≥ 4 |
| `interactive` | on the final report |

Log iterations in `07-refine-log.md` so the score history is inspectable.

Score every dimension 1–5. A section is done when all dimensions score ≥ 4, or
the mode's pass budget is spent (note the residual weakness if so).

| Dimension | 1 (poor) | 3 (adequate) | 5 (excellent) |
|-----------|----------|--------------|---------------|
| **Citation coverage** | many unsupported claims | most claims cited | every factual claim has `[S###]` |
| **Numerical accuracy** | numbers without quotes | most numbers quoted | all numbers have a verbatim quote + locator |
| **Contradiction handling** | hidden or averaged | mentioned, not detailed | side-by-side with both citations |
| **Scope accuracy** | overgeneralised | mostly qualified | every claim scoped to its evidence |
| **Completeness** | major questions unanswered without explanation | most addressed | all answered or marked as a gap |
| **Coherence** | disconnected sections | readable flow | clear arc answering the primary question |
| **Language quality** | errors, inconsistent style | clean but plain | professional, right for the audience |
| **Gap honesty** | gaps hidden | mentioned briefly | detailed with next steps |

Critique questions to answer each pass, driving concrete revision actions:
citation audit (any uncited factual sentence?), numerical verification (every
number traceable to a verbatim quote?), contradiction check (any hidden or
averaged?), scope check (any absolute language beyond the evidence?),
completeness (any brief question missing from both report and gaps?), primary
question alignment (does the Summary answer it?), observation-vs-inference
(any unmarked inference stated as fact?). Two identical critiques in a row means
you have hit the ceiling — accept it and note it rather than looping.

## 7.6 The coherence pass

Read the assembled draft start to finish, once, doing only this:

- **Cut repetition.** Independently written sections restate the same finding.
  Keep the strongest instance and cross-reference from the rest.
- **Check the through-line.** Does the report answer the primary question, or
  does it answer the sub-questions and leave the reader to assemble the answer?
  The Summary must do the assembling.
- **Verify every number against its evidence record.** Numbers drift during
  writing. Mechanical, digit-by-digit, against the quote.
- **Strip hedge-stacking.** "Some evidence may possibly suggest" is noise. Use
  the consensus label and state the finding plainly.
- **Strip unearned confidence too.** Any bare assertion with no citation is
  either signposting or a leak of your own priors. Find and fix them.
- **Check the ordering.** Most decision-relevant material first. A finding
  buried in section 6 that changes the answer belongs in the Summary.
- **Read the limitations as an adversary.** Would someone who disagrees find
  their strongest objection already acknowledged? If not, add it.

## 7.7 Writing rules

- **Every factual claim cites one or more ledger ids.** No orphan claims; if a
  sentence cannot be cited, label it as inference or cut it.
- **Numbers carry a verbatim quote.** Format: `47% [S001 §3.1]`, with the quote
  in the evidence record. A number in the summary absent from its quote is
  refused by `add-evidence`; a figure whose only support is an abstract-only
  source is an audit error outside `quick` mode.
- **Contradictions are never averaged.** Present both sides with citations and
  the classification.
- **Separate observation from inference.** Findings from sources and your own
  synthesis go in visibly different sections; label inference as inference.
- **Date everything.** Publication year per source, the currency line in the
  report, a flag on any fast-moving fact.

**Language and translation.** The body is written in `--output-lang`. Source
titles, author names, and verbatim quotes stay in their original language;
translate a quote only alongside the original:
*"les résultats montrent une augmentation de 30%" (the results show a 30%
increase) [S005]*. Established technical terms (transformer, fine-tuning) stay
in English regardless of output language; expand acronyms on first use.

## 7.8 `gaps.md`

```markdown
# Gaps and next steps — <topic>

## Unanswered questions
| SQ | Question | Why unanswered | What would answer it |
|----|----------|----------------|----------------------|
| SQ5 | multi-tenant scale | no source reports per-tenant metrics | production case study varying tenant count |

## Evidence-quality gaps
<Claims resting on one source, on preprints, on vendor sources, or on secondary
sources that could not be traced to the primary study.>

## Field-level gaps
<What the literature itself does not study: unexamined populations, a
comparator every paper shares, an outcome nobody measures.>

## Searches worth running that were out of scope
<Specific queries, databases, or languages, with what each would likely add.
Written so someone else could pick this up.>

## Facts with a short shelf life
<Prices, versions, model capabilities, rankings, vendor claims — what will need
rechecking, and roughly when.>
```

`gaps.md` is what makes the research resumable. Write it as instructions to the
next person, who may be you in three months with none of this context.

## 7.9 Handoff checklist

Before finalising, verify — most of these are enforced by `ledger.ts audit`
and `audit --report` at stage 8, so run the tool rather than eyeballing:

- Every `[S###]` resolves to an included, read source in the ledger.
- Every number has a verbatim quote in its evidence record.
- Every contradiction from `04-synthesis.md` appears in the report.
- The Summary answers the primary question from `00-brief.md`.
- `gaps.md` is complete and cross-referenced.
- The reference list matches the citations used — no orphans, no gaps.
- Output language is consistent (7.7).
- The **Evidence current as of** line is present.
- `07-refine-log.md` records the passes.

### Inputs and outputs

| Input | Stage | Purpose |
|-------|-------|---------|
| Outline | 1 | structure |
| Verified claims | 5 (Verification) | content that survived CoVe |
| Graph insights | 6 (Knowledge graph) | clusters, bridges, structural gaps |
| Ledger | 3–5 | citations, quotes, metadata, counts |
| Brief | 0/1 | primary question, scope, output-lang, mode |

| Output | Filename | Description |
|--------|----------|-------------|
| Final report | `REPORT.md` | per template (7.3), currency line mandatory |
| Research gaps | `gaps.md` | per structure (7.8) |
| Refinement log | `07-refine-log.md` | Self-Refine passes and score history |
