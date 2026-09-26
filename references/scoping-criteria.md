# Stage 1 — Scope, Criteria, Perspectives, Outline

Two systems drive this stage. **Elicit** supplies the discipline of
writing down what counts as a relevant source *before* you look at any.
**STORM** supplies the machinery for finding out what you don't know you
need to ask, by researching a topic through the eyes of several different
readers rather than one.

A topic is not a research question. Skipping this stage produces a report
that answers something adjacent to what the user wanted.

## 1.1 Sharpen the question

Restate the request as one primary question plus 3-7 sub-questions. The
primary question must be answerable, bounded, and falsifiable in
principle. Sub-questions must be answerable independently — that is what
makes stage 2's fan-out possible.

Pick a framing scaffold that fits the domain:

| Scaffold | Fields | Fits |
|----------|--------|------|
| **PICO** | Population, Intervention, Comparator, Outcome | Clinical, intervention studies, A/B-style comparisons |
| **SPIDER** | Sample, Phenomenon of Interest, Design, Evaluation, Research type | Qualitative, mixed-method, UX research |
| **Technology evaluation** | Workload, Candidates, Constraints, Decision criteria, Alternatives rejected | Tool, library, vendor, architecture choices |
| **Landscape scan** | Domain, Time window, Actors, Dimensions of comparison | Market scans, state-of-the-art surveys |
| **Causal** | Claimed cause, Claimed effect, Mechanism, Confounders, Counter-explanations | "Does X cause Y" questions |

Write the chosen scaffold's fields out explicitly. Vague fields here
become vague queries later.

Also pin the **boundary conditions**, because they decide inclusion:

- Time window (default: last 5 years, plus foundational work regardless
  of age — state the cutoff and why).
- Geography or jurisdiction, if it matters.
- Languages you will accept, and the honest consequence of that limit.
- Evidence types accepted: peer-reviewed, preprints, standards, vendor
  documentation, benchmarks, practitioner reports, news. Rank them.
  `--evidence-tier verified` is how that ranking becomes operational: it
  admits only peer-reviewed work and closes the rest off on both legs. Decide
  it here, at the scope gate, because it changes what stage 2 can find at all.
- Explicitly out of scope, so the report can say so rather than seeming
  to have missed it.

## 1.2 Pre-register the criteria (Elicit)

Write the inclusion and exclusion criteria now, before any search. Each
criterion needs an id, a direction, and a decision rule that can be
applied from a title and abstract alone. If a criterion can only be
judged from full text, mark it as a full-text-stage criterion.

```markdown
| ID | Direction | Criterion | Decidable from | Rule |
|----|-----------|-----------|----------------|------|
| C1 | include | Reports a primary empirical result on <phenomenon> | abstract | Include if the abstract reports its own measurements or dataset |
| C2 | include | Published 2021 or later, or cited >200 times | metadata | Metadata check |
| C3 | exclude | Opinion, editorial, or marketing content with no method | abstract | Exclude if no method, dataset, or evaluation is described |
| C4 | exclude | Retracted or withdrawn | metadata | Check retraction flags |
| C5 | include | Sample size reported | full text | Full-text stage only |
| C6 | exclude | Not peer-reviewed — preprint, blog, vendor doc, thesis, news | metadata | Only under `--evidence-tier verified`. Check venue and publication type |
```

Two calibrations, and they pull in opposite directions:

- **Soft (high-recall) screening** admits a paper unless it explicitly
  fails a criterion. Use it at the abstract stage — abstracts omit things
  that the full text has, and a wrongly excluded paper is invisible later.
- **Strict screening** demands explicit evidence for every criterion. Use
  it at the full-text stage, where absence of evidence is informative.

Default: soft at abstract stage, strict at full-text stage. Say which
you used in the report; it changes how the numbers should be read.

Register the criteria in the ledger so screening can reference them:

```bash
bun $SKILL/scripts/ledger.ts add-criterion \
  --dir research/<slug> --id C1 --direction include \
  --text "Reports a primary empirical result on <phenomenon>" --stage abstract
```

Under `--evidence-tier verified`, C6 is not optional decoration — register it,
because an exclusion recorded against a criterion is what makes the tier
auditable rather than a habit:

```bash
bun $SKILL/scripts/ledger.ts add-criterion \
  --dir research/<slug> --id C6 --direction exclude --stage metadata \
  --text "Not peer-reviewed (preprint, blog, vendor doc, thesis, news)"
```

## 1.3 Discover perspectives (STORM)

A single researcher asks a narrow set of questions. STORM's insight is
that you get much better coverage by researching the topic as several
different readers would, then merging what they each turn up.

Derive 3-6 perspectives. Three ways to find them, in order of preference:

1. **Borrow the structure of existing overviews.** Find 2-4 survey
   articles, review papers, or well-developed Wikipedia articles on
   adjacent topics and read their tables of contents. Recurring
   top-level sections are the perspectives the field itself uses.
2. **Read the field's own taxonomy.** OpenAlex tags every work with
   topics, subfields, and fields. Group your seed results by topic and
   the clusters are candidate perspectives:
   ```bash
   bun $SKILL/scripts/scholar.ts trend \
     --q "<topic>" --group primary_topic.id
   ```
3. **Enumerate stakeholders.** Who cares about the answer and what would
   each one ask first? Practitioner, researcher, buyer, regulator,
   skeptic, operator, end user.

Always include an adversarial perspective — the reader looking for
reasons the mainstream view is wrong. It is the cheapest defence against
a report that only confirms what the user already believed.

Write each perspective as a role plus its concerns plus the questions it
would naturally ask:

```markdown
### P2 — Production operator
Concerns: failure modes, cost at scale, latency tails, on-call burden.
Would ask: what breaks first under load? what does it cost per unit of
work? what does the recovery path look like? what do people who ran it
for a year say?
```

## 1.4 Perspective-guided Q&A (STORM)

For each perspective, simulate a multi-turn conversation between a
**writer** holding that perspective and a **topic expert**. Rules:

- The writer asks one question per turn, and each question must be
  conditioned on the previous answer. Follow-ups are where the
  interesting material surfaces; a flat list of independent questions
  wastes the method.
- The expert answers **only from retrieved sources**. Every answer must
  cite the sources it drew on, and every one of those sources enters the
  ledger. If retrieval returns nothing usable, the expert says so — that
  becomes a gap, not an invention.
- 3-5 turns per perspective in `standard`, 5-8 in `systematic`.
- Break the writer's question into search queries before answering; do
  not answer from your own knowledge.

The valuable output is twofold: the conversation content, and the pile of
sources it collected. Both feed the outline.

For efficiency, run perspectives in parallel with `<subagent>`
(general-purpose role), one agent per perspective, each returning its
transcript and source list in the contract format from
`references/executor-contract.md`.

## 1.5 Build the outline (STORM)

Outline before prose. Two passes, in this order:

1. **Draft outline** from your own knowledge of how such a topic is
   normally organised. Fast, and gives the structure something to
   improve on.
2. **Refined outline** using the collected conversations. Add sections
   the conversations demanded, split sections carrying too much
   unrelated material, drop sections nothing was found for, and reorder
   so the report answers the primary question early rather than at the
   end.

Each leaf section gets: a heading, the sub-question it answers, the
perspectives that asked for it, and the ledger ids of sources already
collected for it. That mapping is how you detect thin sections before
writing rather than during.

```markdown
## 3. Failure modes under sustained load
Answers: SQ4 — what breaks first at scale?
Asked by: P2 (operator), P5 (skeptic)
Sources so far: S004, S011, S019
Status: thin — need at least one production post-mortem
```

Mark every section `covered` / `thin` / `empty`. Thin and empty sections
are stage 3's targets.

## 1.6 Co-STORM additions (interactive mode only)

In `interactive` mode the user sits inside the conversation rather than
reviewing its output. Three additions:

**The roundtable.** Each turn, one of these speaks: a perspective-holding
expert (answers grounded in fresh retrieval), the **moderator**, or the
user. Announce who is speaking.

**The moderator injects unknown unknowns.** This is the point of
Co-STORM. After each expert turn, look at retrieved material that was
*collected but not used* — the passages that didn't answer the question
asked. Pick the most surprising one and turn it into the next question.
This is what surfaces the things the user didn't know to ask about.
Without it the conversation converges on the user's existing frame.

**The mind map.** Maintain a running hierarchical index of everything
collected, so the conversation doesn't lose earlier material. Update it
after each turn and show it on request. Concept nodes hold source ids:

```markdown
# Mind map — <topic>
- Retrieval quality
  - Chunking strategy .......... S003, S007, S014
  - Reranking ................... S008, S021
  - Evaluation harnesses ........ S011
- Cost and latency
  - Serving cost ................ S005, S018
  - Tail latency ................ S019   [contested: S022 disagrees]
- Failure modes
  - Stale index ................. S012
  - (nothing yet on multi-tenant isolation)   [gap]
```

Explicit `[gap]` markers for branches with no sources — an empty branch
is a finding.

Every 3-4 turns, offer the user: keep going, steer to a branch, drill
into one, or stop and write the report.

## 1.7 Deliverable: `00-brief.md`

```markdown
# Research Brief — <topic>
**Created**: <date>   **Mode**: <mode>   **Output language**: <lang>

## Primary question
<one sentence, answerable>

## Sub-questions
SQ1 ... SQ7  (each independently searchable)

## Framing
<scaffold name and its fields filled in>

## Boundary conditions
Time window / geography / languages / evidence types accepted and ranked
/ explicitly out of scope

## Inclusion and exclusion criteria
<the table from 1.2, with stage per criterion>
Screening calibration: soft at abstract, strict at full text

## Perspectives
P1 ... Pn — role, concerns, opening questions (one must be adversarial)

## Source budget
Target: <n> sources. Priority source types: <list>.

## Known risks in this research
<e.g. vendor-dominated literature; fast-moving facts; English-only
coverage; likely publication bias toward positive results. Under
`--evidence-tier verified`, say plainly what the tier costs: in CS and ML the
result that matters is often six months from a journal, so a verified-only
corpus can be a year behind the field.>
```

Stop here. Present the brief and wait — this is the **scope gate**, and
it is the cheapest place to correct course. Offer numbered options:
approve as-is, adjust the question, adjust criteria, add or drop a
perspective, or change mode.
