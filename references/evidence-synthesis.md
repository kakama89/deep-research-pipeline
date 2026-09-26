# Stages 5 and 6 — Evidence Gathering, Contradictions, Synthesis

This is **PaperQA2's** contribution, and it is the part most retrieval
pipelines get wrong. Naive RAG retrieves the top-k chunks by embedding
similarity and hands them to a writer. PaperQA2 adds a step in between
that changes the quality of the result: every candidate passage is
summarised *relative to the question being asked* and given an explicit
relevance score, and only what clears the threshold is allowed to
influence the answer.

The other thing it contributes is a stance: an agent that cannot support
an answer says so. PaperQA2 refuses rather than filling the gap. That is
what makes the citations mean something.

## 5.1 The tool loop

PaperQA2 is an agent with four tools and a persistent state. Mapped onto
what is available here:

| PaperQA2 tool | Here |
|---------------|------|
| `paper_search` | `scholar.ts search` + `<search>` |
| `gather_evidence` | fetch full text, chunk, summarise per question, score (5.2) |
| `gen_answer` | synthesis with inline ledger ids (5.5) |
| `citation_traversal` | `scholar.ts cites` forward and backward (5.4) |

The loop runs **per research question**, not once for the whole topic.
Evidence relevant to SQ3 is not evidence for SQ5, and scoring against
"the topic" instead of against a question is how irrelevant passages get
promoted.

```
for each research question:
    gather candidates (already-included sources first)
    score and keep the ones that clear threshold
    if evidence is thin:
        traverse citations from the best sources
        reformulate the query with the vocabulary you just learned
        repeat, up to 3 rounds
    if still thin:
        record insufficient evidence and move on   <- do not invent
```

The stopping condition matters as much as the loop. Three rounds, then an
honest gap.

## 5.2 Retrieval-contextual summarization (RCS)

For each candidate passage, produce a record. The order of operations is
what makes this work — summarise **before** scoring, and score the
summary's answer to the question, not the passage's topical similarity.

```json
{
  "source": "S014",
  "question": "SQ3 — what latency cost does reranking add?",
  "summary_wrt_question": "Reports median added latency of 34ms for a cross-encoder reranker over 50 candidates on an A10G, rising to 210ms at 500 candidates. Measures only the reranking step, excluding retrieval.",
  "quote": "reranking 50 candidates added a median of 34 ms (p99 71 ms)",
  "locator": "§5.2, Table 3",
  "score": 9,
  "scope_note": "single hardware config; no CPU-only numbers"
}
```

Score 1-10, against **this question**:

| Score | Meaning |
|-------|---------|
| 9-10 | Directly answers it with specifics |
| 7-8 | Substantively addresses it, some qualification needed |
| 5-6 | Related and useful context, does not answer it |
| 3-4 | Same topic, no bearing on the question |
| 1-2 | Retrieved on a keyword coincidence |

**Threshold: keep 6 and above, cite 7 and above.** This is enforced, not
advisory: `add-evidence` *refuses* a score below 6, so a sub-6 passage
never becomes a record — discard it rather than trying to hoard it. The
cite-at-7 line is checked by `audit` (a warning below 7). Low-relevance
passages in a writing context produce vague prose that cites real sources
for claims they do not make.

Three rules that carry most of the value:

- **`summary_wrt_question` must be written for the question.** A generic
  abstract-style summary defeats the whole method. If the passage does
  not bear on the question, that is a low score, not a summary of what
  the passage is about instead.
- **`quote` is verbatim.** Copy it. Any number in the summary must
  appear in the quote — `add-evidence` **refuses the record** (exit 2)
  otherwise, including when the unit was converted: a quote of "0.87"
  does not license a summary of "87%". Extend the quote or drop the
  figure; this is the mechanism that stops numeric drift, and it now
  stops it at the moment the record is made rather than at the audit.
- **A number needs the full text.** The record carries the source's
  reading scope. An abstract states a result without its method, so a
  figure from an abstract that goes on to back a claim is an audit error
  outside `quick` mode, and in `systematic` mode the record is capped at
  6 — context only. `scholar.ts fetch --id <doi>` is usually one command
  away from fixing that.
- **`scope_note` records the conditions.** "34ms" is meaningless without
  the hardware, the candidate count, and what was excluded from the
  measurement. Most apparent contradictions in a literature turn out to
  be scope differences, and this field is what lets you tell them apart.

```bash
bun $SKILL/scripts/ledger.ts add-evidence \
  --dir research/<slug> --source S014 --question SQ3 --score 9 \
  --summary "median added latency 34ms for cross-encoder over 50 candidates on A10G" \
  --quote "reranking 50 candidates added a median of 34 ms (p99 71 ms)" \
  --locator "§5.2, Table 3"
```

## 5.3 Chunking full text

Chunk on **semantic boundaries**, not fixed character counts. Sections
and subsections; keep tables with their captions; keep a figure caption
with the paragraph that discusses it. A fixed-width chunker splits a
results table from its units and produces numbers with no meaning.

Prioritise: Results and Findings first, then Methods (for the scope
note), then Discussion (for the authors' own caveats), then Limitations,
then Related Work last. Abstract and Introduction are the *least*
reliable — they state what the authors want the reader to take away,
which is not always what the results show. Never take a number from an
abstract if the results section has it.

Read the Limitations section of every included source. It is where
authors themselves tell you the constraint that your report needs to
carry, and it is the most-skipped section in the paper.

## 5.4 Citation traversal as retrieval

When evidence for a question is thin, the citation graph outperforms more
keyword search — because the field has already curated it.

- **Backward** from your best sources: what did they cite when making
  this specific claim? That is usually the primary study, and a claim
  traced to its primary source is far stronger than one resting on a
  secondary report.
- **Forward** from the same sources: who built on this, and did anyone
  fail to replicate it? Forward traversal is the only reliable way to
  find a refutation, and it is the step that catches a widely repeated
  finding that was later overturned.

```bash
bun $SKILL/scripts/scholar.ts cites \
  --id <best-source-id> --direction citing --limit 50 --out forward.json
```

**Citation laundering** is the failure mode to watch for. Source B says
"X is true [A]". You cite B for X. But A does not actually say X, or says
it under conditions B dropped. Any claim that matters must be traced to
the source that made the measurement. If tracing is impossible, mark the
claim `secondary-source-only` and say so in the report.

## 5.5 Contradiction detection

PaperQA2's authors found contradictions to be common rather than
exceptional — an average of roughly 2.3 per paper in a sample of biology
papers, with about 70% of those confirmed by human experts
([Skarlinski et al., 2024](https://arxiv.org/abs/2409.13740)). Expect to
find them. Finding none in 30 papers means you did not look.

Compare evidence records pairwise within each question, then classify.
The classification is the useful part, because most pairs are not
actually in conflict:

| Class | Meaning | How to report |
|-------|---------|---------------|
| **Direct** | Same question, same conditions, incompatible results | Report both, compare method quality, state which is better supported and why |
| **Scope** | Different populations, hardware, scale, time period | Not a contradiction. Report both with their conditions attached |
| **Methodological** | Different measurement or definition of the outcome | Explain the definitional difference; the disagreement is often about the metric |
| **Version drift** | Subject changed between studies (software version, model, policy) | Date both, prefer current, keep the old one as history |
| **Interpretive** | Same data, different conclusions drawn | Report the data once, both interpretations separately |

```bash
bun $SKILL/scripts/ledger.ts contradiction \
  --dir research/<slug> --a E012 --b E019 --class scope \
  --note "E012 measures A10G at 50 candidates; E019 measures CPU-only at 500"
```

Never average two conflicting numbers into a middle figure. That produces
a number no source supports, which is the worst possible output — it
carries citations for a value nobody measured.

Also check the pattern the extraction matrix exposes: do the
contradictions line up with `funding_interest`? If independent studies and
vendor studies disagree systematically, that is a headline finding, not a
footnote.

## 5.6 From evidence to claims

Group evidence records into claims. A claim is one assertion the report
will make, plus the evidence supporting it, plus a consensus label.

```bash
bun $SKILL/scripts/ledger.ts claim \
  --dir research/<slug> --id CL03 \
  --text "Cross-encoder reranking adds tens of milliseconds at small candidate counts but scales superlinearly" \
  --evidence E012,E019,E027 --consensus moderate
```

Consensus labels, and the rules are strict because this label is what a
reader uses to decide how much weight to give a claim:

| Label | Requirement |
|-------|-------------|
| **strong** | 3+ independent sources agree, no credible contradiction, methods sound |
| **moderate** | 2+ agree, or 3+ with minor scope variation |
| **contested** | Credible evidence on both sides. Both must appear in the report |
| **thin** | 1 source only. Say "one study reports", name it, do not generalise |
| **absent** | Nothing found. Goes to `gaps.md`, not into the report as a finding |

**Independence** is a real constraint. Three papers from the same lab
reusing the same dataset are one source, not three. Check authors,
affiliations, and datasets before labelling anything `strong`. This is
the most common way a consensus label ends up overstated.

Never let a `thin` claim become a general statement. "One study of 40
users found X" is honest; "users find X" is not.

## 5.7 The refusal rule

If, after three rounds, the evidence does not answer a question:

```markdown
### SQ5 — Does <X> hold at multi-tenant scale?
**Insufficient evidence.** 14 sources screened for this question; none
reports multi-tenant measurements. The closest, S022, measures a single
tenant at comparable volume (E031, score 6) and explicitly declines to
generalise. Two vendor pages assert it without data and were excluded as
`vendor-marketing`.

What would answer it: a production case study with per-tenant isolation
metrics, or a benchmark that varies tenant count as an independent
variable. Searched: <queries>. Nothing found.
```

This is a good deliverable, not a failure. State it, name what is
missing, name what would settle it, and put it in `gaps.md`. A report
that admits three gaps and supports everything else is more useful than
one that answers everything at uniform, unverifiable confidence.

Never bridge a gap with background knowledge presented as a finding. If
you have relevant knowledge that no source supports, put it in a clearly
labelled `Analyst assessment (not sourced)` block, or leave it out.

## 5.8 Where this feeds

The claims and contradictions written here are the input to **Stage 4
synthesis**, which arranges them into the `04-synthesis.md` deliverable and
runs the sufficiency gate (which questions are solidly answered, which are
thin, whether the user wants another retrieval wave before writing). This
file owns the *classification* — relevance scoring, contradiction classes,
consensus labels; `references/04-synthesis.md` owns the STORM and debate
protocols and the deliverable layout. Do not duplicate the label
definitions there; point at this file.
