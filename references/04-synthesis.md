# Stage 4 — Synthesis (STORM + Multi-Agent Debate)

> **Wiring** · Tools: `ledger.ts claim` (text + evidence ids + consensus
> label) and `ledger.ts contradiction` (two evidence ids + classification).
> The debate transcript is prose in `04-synthesis.md`; its *outcome* is a
> claim record with a consensus label. `audit` rejects `strong` on fewer
> than three independent sources and any single-source claim not labelled
> `thin`. **Do not hand-edit `ledger.json`** — if a field is not in the
> schema, the pipeline does not track it, so say it in prose here.
>
> This file owns the **STORM perspective protocol** and the **debate
> protocol**. Consensus labels, the never-average rule, and the five
> contradiction classes are defined in `references/evidence-synthesis.md`
> (§5.5, §5.6), which wins on classification. This file shows how a debate
> *produces* the label and the contradiction record written there.

**Leaving this stage** — `ledger.ts state` holds it open until at least one
claim is recorded (`claim`) and `04-synthesis.md` exists. No gate here: the
sufficiency gate is behind you and the audit gate is ahead.

## Overview

Stage 4 turns screened evidence into findings through two processes that
feed the same ledger records:

1. **STORM multi-perspective analysis** — perspective-guided Q&A grounded
   only in evidence records, surfacing content and cross-source connections.
2. **Multi-agent debate** — adversarial dialogue that stress-tests each
   contested claim until consensus or documented disagreement.

**Inputs:** `03-screening.md`, `03-extraction.md`, `ledger.json` (evidence
records with 1–10 relevance scores), `01-plan.md` (research questions and
stage-1 perspectives). **Outputs:** `04-synthesis.md` (this stage's prose,
including debate transcripts) and ledger records from `ledger.ts claim` /
`ledger.ts contradiction`; insufficient questions go to `gaps.md`.

The claim record is exactly `{id, text, evidence[], consensus, at}`. There
is no ledger slot for a debate transcript, a confidence float, a
research-question id, or a cross-reference list — all of that is prose here.
Every count you cite comes from `ledger.ts stats`.

---

## 4.1 STORM perspective discovery → debate positions

Stage 1 discovered 3–6 perspectives. Stage 4 makes each one a questioning
lens, and — the join between the two halves of this stage — **a perspective
that disagrees with another becomes a debate position** in §4.2.

For each perspective, note its lens, priorities, and known blind spot as a
short prose list in `04-synthesis.md`. This is not ledger state.

```markdown
Perspectives consulted this run:
- Technical feasibility — values scalability, performance; blind to business context
- Cost / market — values ROI, adoption cost; blind to technical constraints
- End-user — values usability, adoption barriers; blind to backend complexity
```

### Perspective-guided Q&A

The Q&A is a dialogue between a **Writer** (asks) and each perspective
(answers). Rules:

1. Answer **only** from evidence records in the ledger — no general
   knowledge, no fabrication.
2. Every answer cites evidence ids (`[E007]`, `[E012]`).
3. When filtering candidate evidence, the scores are the integer **1–10
   relevance scores** on the records. You only have records scoring 6+
   (`add-evidence` refused the rest); cite from 7+.
4. If nothing in the ledger answers, the perspective says so and the gap is
   logged to `gaps.md` — never invent an answer.

Turns per perspective by mode: quick 2–3, standard 3–5, systematic 5–8.

```
for each perspective:
    for turn in 1..max_turns[mode]:
        Writer asks a question in this perspective's lens
        filter evidence records relevant to it (you have only score >= 6)
        the perspective answers, citing [E###] ids
        note any NEW cross-source connection it exposes
        enough depth? -> next question, else -> next perspective
```

Cross-source connections (one source's finding amplifying another's) are
prose in `04-synthesis.md` under a "Patterns across the corpus" heading —
not a ledger record. If a connection becomes an assertion the report will
make, it graduates to a `claim` in §4.3.

---

## 4.2 Multi-agent debate protocol

Debate stress-tests the claims that STORM surfaced. It runs **per contested
claim**, not per topic.

### Roles

| Role | Stance | Does |
|---|---|---|
| **Advocate** | for the claim | strongest case from the evidence records |
| **Critic** | against | weaknesses, alternative readings, scope limits, contradicting evidence |
| **Synthesizer** | neutral | names common ground, picks the consensus label, classifies any conflict |
| **Fact-Checker** | neutral | confirms every cited `E###` exists and is not misrepresented |

### Rounds by mode — when to stop

| Mode | Rounds | Stop rule |
|---|---|---|
| **quick** | skip | rely on STORM output; label claims directly |
| **standard** | 2 per claim | stop early if the Synthesizer reaches a label in round 1 |
| **systematic** | 3+ per claim | continue until the Synthesizer declares resolution, or a round limit of 5 on a genuine stalemate |
| **interactive** | roundtable turns | each turn is a gate; the moderator injects unused evidence between turns; stop when the user is satisfied or evidence is exhausted |

Stop debating when one of these is true: the Critic's challenges are all
addressed, the Critic lands an unanswerable objection (→ `contested` or a
`contradiction` record), or a round adds no new evidence or argument. A
stalemate after the round limit is itself a result: label `contested`,
document both sides.

### One debate, in shape (~15 lines)

```markdown
CLAIM: microservices raise deploy frequency 2–5x for teams of 10+.

Advocate: [E008] DORA study, 3.2x median; [E014] case study 4.7x;
          [E019] 78% report faster deploys.
Critic:   [E019] surveys only successful adopters (survivorship);
          [E014] changed CI/CD at the same time (confounder);
          [E008] says the effect vanishes below 5 devs (scope).
Advocate: concede small-team scope. [E008] regresses out tooling;
          [E027] longitudinal, gains hold 3 years.
Fact-Checker: E008, E014, E019, E027 all exist and are read; E014's
          confounder is real per its methods section.
Synthesizer: label moderate — core effect supported, magnitude holds
          only for teams >=10; whether *microservices* vs general
          modularization drives it is unresolved -> note as scope.
```

The transcript stays in `04-synthesis.md`. Its *outcome* — the label and
any conflict — becomes ledger records in §4.3.

---

## 4.3 Debate outcome → ledger records

A debate ends in one claim record plus, if the conflict was real, one or
more contradiction records. **The consensus vocabulary is fixed by the
scripts** and defined in `evidence-synthesis.md` §5.6; the mapping from a
debate outcome:

| Debate outcome | `--consensus` | Also write |
|---|---|---|
| 3+ independent sources agree, no surviving objection | `strong` | — (audit errors if <3 independent) |
| 2+ agree, or 3+ with minor scope variation | `moderate` | — |
| credible evidence on both sides, unresolved | `contested` | a `contradiction` per conflicting pair |
| one source only | `thin` | — (never generalise a `thin` claim) |
| nothing found | `absent` | goes to `gaps.md`, not the report |

There is **no `insufficient` and no `contradicted` consensus value.** A
question with too little evidence is `thin` (one source) or `absent`
(none). A claim the evidence turns against is not a consensus label: record
`consensus=contested` and file a `contradiction` for the opposing pair,
then let stage 5 verification decide whether it ships (`verify --status
contradicted` is a separate, later step).

`strong` and `moderate` require **independent** sources — different
authors, affiliations, and datasets; three papers from one lab on one
dataset are one source. `audit` errors on `strong` under three independent
sources and warns when `strong`/`moderate` sources share authors or venue.

### Writing the records

```bash
# the moderate claim from the debate above
bun $L claim --dir $R --id CL03 \
  --text "Microservices raise deployment frequency 2–5x for teams of 10+, though whether the driver is microservices or general modularization is unresolved" \
  --evidence E008,E014,E019,E027 --consensus moderate

# a contested claim keeps BOTH sides, and each conflicting pair gets a record
bun $L claim --dir $R --id CL07 \
  --text "Whether to optimise for deploy speed or system reliability is genuinely split" \
  --evidence E010,E018,E023,E029 --consensus contested

bun $L contradiction --dir $R --a E010 --b E023 --class interpretive \
  --note "Same adoption data; E010 reads it as a speed win, E023 as a stability risk"
```

Pick `--class` from the five the script accepts — `direct`, `scope`,
`methodological`, `version-drift`, `interpretive` — per `evidence-synthesis.md`
§5.5. Do not invent a parallel taxonomy: a "divergence" is usually `direct`
or `interpretive`, a "temporal shift" is `version-drift`, a "methodological
split" is `methodological`, and a difference in population, scale, or
hardware is `scope` — **not** a contradiction to average away.

### Observation vs inference

Keep what the sources say separate from what you concluded. Evidence-backed
findings go under the sub-question headings. Any synthesis of your own that
no single source states — a cross-source connection, an extrapolation —
goes in a clearly labelled **`Analyst assessment (not sourced)`** block and
never receives a `[S###]`. This is non-negotiable 7, and it is what stops
inference from being read as evidence.

---

## 4.4 Cross-source synthesis and the sufficiency gate

Group evidence by research question, look for the patterns
`evidence-synthesis.md` §5.5 describes (convergence raising confidence,
divergence to investigate, scope differences that are not conflicts), and
turn each settled group into a claim. Agreement across *different* methods
is stronger than agreement within one.

Then run the **sufficiency gate** before stage 5, judging each question
from `ledger.ts stats`:

| Status | Reading | Action |
|---|---|---|
| **Solid** | 3+ independent sources, consensus `moderate`+ | ready to write |
| **Thin** | 1–2 sources, or a single methodology | offer a deeper search |
| **Empty** | no evidence survived | move to `gaps.md` |

Present it in prose and wait — this is a gate:

```markdown
## Research readiness
Solid: SQ1 performance (5 sources, strong); SQ4 security (4 sources, contested — both sides)
Thin:  SQ2 migration cost (2 sources) — write with caveats / search deeper / narrow?
Empty: SQ3 team satisfaction — moved to gaps.md

Recommended: write SQ1 and SQ4 now, search deeper on SQ2, drop or reframe SQ3.
Proceed? [write now / search deeper / narrow scope / custom]
```

Next stage after this gate is **Stage 5 — Verification** (CoVe questions,
the self-refuting test, Reflexion). Stage 6 is the knowledge graph, stage 7
is the report. Nothing here is "writing"; writing is stage 7.

---

## 4.5 Deliverable: `04-synthesis.md`

```markdown
# Synthesis — <topic>
Mode: <quick|standard|systematic|interactive>
Perspectives consulted: <list>   ·   Debate rounds: <n from your transcripts>
Evidence base: <n> sources, <n> evidence records, <n> scoring 7+   (from `ledger.ts stats`)

## Answer to the primary question
<3–5 sentences, every clause cited, consensus labels inline>

## By sub-question
### SQ1 — <question>
Consensus: strong
<synthesis citing [S007] [S014] [S022]>   Scope conditions: <…>

### SQ3 — <question>
Insufficient evidence — one source only, labelled thin; see gaps.md.

## Debate transcripts
<one block per contested claim — prose; the outcome is in the ledger>

## Contradictions
| # | Class | Side A | Side B | Assessment |
|---|-------|--------|--------|------------|
| 1 | scope | 34ms [S014] | 210ms [S019] | different candidate counts; not in conflict |
| 2 | direct | improves [S007] | no effect [S031] | S031 larger n + preregistered; S007 vendor-published |

## Patterns across the corpus
<convergence, funding-vs-direction check, shared blind spots — prose>

## Analyst assessment (not sourced)
<inference only, clearly separated, no [S###]>
```

## 4.6 Language handling

Internal Q&A and debate run across the configured query languages
(`--query-lang` may name several); `04-synthesis.md` itself is written in one
language, `output-lang`. Anything you say to the user while synthesising — a
clarifying question, the sufficiency gate — is in `interaction-lang` (default
`output-lang`). Quotes stay in their original language with a translation
alongside — never translate a quote without showing the original. Note when a
finding rests mostly on sources in one language (possible cultural bias), and
when several query languages were configured, note if one of them turned up
little or nothing — that is itself a coverage finding, not just a null result.

## Checklist before Stage 5 (Verification)

- [ ] Every stage-1 perspective consulted; every contested claim debated (mode ≠ quick)
- [ ] Every `ledger.ts claim` carries a valid consensus label; every real conflict has a `ledger.ts contradiction` with a valid class
- [ ] `strong`/`moderate` claims checked for source independence
- [ ] Debate transcripts and cross-source connections captured as prose here, not forced into the ledger
- [ ] Sufficiency gate presented; user approved the plan for thin/empty questions
- [ ] `04-synthesis.md` in `output-lang`, all citations traceable to ledger ids; `gaps.md` updated with `thin`/`absent` questions
