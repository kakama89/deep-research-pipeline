# Stage 5 — Verification (CoVe + Reflexion)

> **Wiring** · One `bun $L verify` call per verification question, writing a
> `V###` record. `bun $L audit --dir $R` runs mid-stage to catch problems
> early. **Never hand-edit `ledger.json`** — `verify` is the only legal way
> to store a verification result.
>
> The tool accepts **exactly four** statuses:
> `supported | partial | unsupported | contradicted`. There is no fifth
> label. A "scope mismatch" is recorded as `partial` with the scope problem
> written into `--note`.

**Leaving this stage** — `ledger.ts state` holds it open until every claim has
at least one verification record and `05-verification.md` exists. `audit`
additionally refuses to let the run ship a claim verified `unsupported`, or one
verified `contradicted` with no `contradiction` record behind it.

## Purpose

Stage 5 is the quality gate. Before synthesis reaches the report, every
claim from stage 4 is independently verified and the output undergoes a
reflective self-improvement pass. Two techniques combine, neither needing
external tools:

1. **Chain-of-Verification (CoVe)** — decompose each claim into verification
   questions, answer them independently, compare against the claim.
2. **Reflexion** — name the error, update episodic memory, regenerate the
   affected output.

Inputs: verified claims live in `ledger.json` as `CL###` records (written
by stage 4 `claim`); evidence as `E###`; the mode from `00-brief.md`
(sets the Reflexion loop count). Outputs: `V###` records via `verify`, the
`05-verification.md` narrative, and any downgraded claims moved to
`gaps.md`.

---

## 5.1 Chain-of-Verification

For every claim from stage 4, the agent:

1. Generates 2–4 verification questions (VQs) whose answers must be true
   **if** the claim is true.
2. Answers each VQ **independently** — without the claim text, its
   paragraph, or the specific evidence linked to it.
3. Compares the independent answers against the claim and picks a status.

Independence is what gives CoVe its power. If the agent can confirm a fact
without being primed by the claim, confidence is real. If answering
requires re-reading the claim, the check has degenerated into paraphrase.

**Claim types** worth flagging when generating VQs: quantitative (a
number), comparative (X beats Y), causal (X causes Y), categorical,
temporal, existential. Quantitative and causal claims need the sharpest
questions.

**VQs should be** specific, independently answerable, diagnostic (their
answer either supports or undermines the claim), and diverse (source,
method, scope, replication).

Answer each VQ only from general knowledge and the cached source text under
`$R/sources/S###.md` — never from the synthesis paragraph.

### One worked example

| Claim | "RAG reduces hallucination by 60% vs. a base LLM" |
|---|---|
| VQ1 | Which study measured hallucination reduction from RAG, and by how much? |
| VQ2 | What baseline and metric were used? |
| VQ3 | On what dataset or task? |
| VQ4 | Do other studies report a similar magnitude? |

Independent answers land the improvement at 20–50% across QA benchmarks,
with no major study reporting exactly 60%. The claim overstates its
magnitude → record as `partial`, narrow it, and put the scope correction in
`--note`.

---

## 5.2 The four statuses

| Status | Meaning | Action |
|---|---|---|
| `supported` | Every VQ answer aligns with the claim | Keep the claim |
| `partial` | Some VQs align, others are inconclusive **or** the claim is true only within a narrower scope | Add a qualifier / narrow the scope; record the limit in `--note` |
| `unsupported` | The evidence cannot confirm the claim | Fix, downgrade, or move to `gaps.md` — an `unsupported` claim may **not** ship |
| `contradicted` | A VQ answer directly disagrees with the claim | Revise the claim to match evidence; **requires** a matching `contradiction` record |

Decision rules:

- All VQ answers align → `supported`.
- Answers support only a subset of the claimed scope, or some are
  inconclusive → `partial` (put the scope/qualification in `--note`).
- Answers are all inconclusive → `unsupported`.
- Any answer directly contradicts → `contradicted`.

**`unsupported` is a hard stop.** `audit` errors on any claim whose
verification is `unsupported`, so it cannot reach the report. Resolve it by
finding real supporting evidence, downgrading the claim's `consensus`, or
moving the assertion to `gaps.md`.

**`contradicted` needs a paired record.** `audit` errors on a
`contradicted` verification that has no matching `bun $L contradiction`
record. Record the conflicting evidence pair first (or alongside).

---

## 5.3 Running `verify` — all four statuses

One record per verification question. Set `$L` and `$R` per
`references/ledger.md`.

`supported`:

```bash
bun $L verify --dir $R --claim CL002 \
  --question "What is the time and space complexity of standard self-attention?" \
  --answer "O(n^2) in both, from the pairwise attention matrix (Vaswani 2017)." \
  --status supported --evidence E018
```

`partial` (a scope mismatch — the scope problem goes in `--note`):

```bash
bun $L verify --dir $R --claim CL001 \
  --question "By how much does RAG reduce hallucination, and on what task?" \
  --answer "20-50% factual-accuracy gain on QA benchmarks; no study reports 60%." \
  --status partial --evidence E012,E015 \
  --note "Claim overstated the magnitude; narrowed to 20-50% on QA benchmarks."
```

`unsupported` (then fix / downgrade / move to gaps.md — it cannot ship):

```bash
bun $L verify --dir $R --claim CL015 \
  --question "What source supports a 4x inference-cost reduction for MoE?" \
  --answer "No source in the corpus states a 4x figure." \
  --status unsupported \
  --note "No evidence for 4x; moved to gaps.md."
```

`contradicted` (record the contradiction first, or the audit errors):

```bash
bun $L contradiction --dir $R --a E031 --b E040 --class direct \
  --note "Ouyang 2022 shows RLHF reduces but does not eliminate hallucination."
bun $L verify --dir $R --claim CL003 \
  --question "Does RLHF eliminate or only reduce hallucination?" \
  --answer "Reduces only; TruthfulQA improves but stays well below 100%." \
  --status contradicted --evidence E031,E040 \
  --note "Absolute claim contradicted; revised to 'reduces certain types'." 
```

Confirm flags before use: `bun $L verify --help` and `bun $L audit --help`.

---

## 5.4 Errors to detect — asked as questions

For each claim, ask the following against the fields that actually exist on
an evidence record (`summary`, `quote`, `locator`, `score`, `scope_note`)
and on the source (`year`, `read_at`). Do not assume fields like `stance`,
`study_design`, or `limitations` — they are not in the schema.

| Error | The question to ask | Fields to read |
|---|---|---|
| Unsupported claim | Does every factual sentence cite a `CL###`/`E###`-backed record? | claim `evidence[]` |
| Numerical drift | Does each number in the claim appear verbatim in its evidence `quote`? | evidence `quote`, `summary` |
| Overgeneralization | Is the claim broader than the evidence `scope_note` allows? | evidence `scope_note` |
| Cherry-picking | Is there a recorded `contradiction` on this topic the claim ignores? | `contradictions[]` |
| Stale facts | Is the newest supporting source old while newer work likely exists? | source `year` |
| Causal overclaim | Does the `quote` actually assert causation, or only association? | evidence `quote` |
| Missing qualification | Does the `scope_note` name a limit the claim omits? | evidence `scope_note` |

Address errors in priority order: contradicted claims first, then numerical
drift, causal overclaim, unsupported, overgeneralization, cherry-picking,
missing qualification, stale facts.

Numerical drift and the never-average rule are enforced structurally — see
`references/evidence-synthesis.md` for contradiction classes and the rule
that conflicting findings are reported side by side, never blended.

---

## 5.5 Self-refuting test

After CoVe and Reflexion, adversarially try to **disprove** the report's
top 3–5 conclusions.

1. State each main conclusion.
2. Formulate the strongest counter-argument.
3. Search for counter-evidence *not* already in the corpus — negation
   keywords, failed replications, methodological critiques, newer
   contradicting findings.
4. Act on what you find:

| Counter-evidence | Action |
|---|---|
| Strong (peer-reviewed, recent, direct) | Add source to ledger → re-run the stage-4 debate for that claim; record a `contradiction` |
| Moderate (indirect or older) | Add as a qualification (record `partial` with the caveat in `--note`) |
| Weak (opinion, non-peer-reviewed) | Note it exists; do not change the conclusion |
| None found | Records as supporting confidence |

Any strong counter-evidence that survives becomes a `contradicted` or
`partial` verification with the matching contradiction record.

---

## 5.6 Reflexion loop

Reflexion is: generate → **name the error** → **update episodic memory** →
**regenerate** the affected claim/section → recheck. Episodic memory is
just a running list held in context — no storage system needed. Each entry
names the error type, what was wrong, and the fix applied (e.g.
"numerical_drift: CL012 said 75% but E019 quote says 73.2% → corrected to
73.2% with citation").

The loop exits when every claim is `supported` or explicitly carries its
status, no claim is `unsupported`, no number drifts from its quote, and
overgeneralizations are scoped.

**Loop counts per mode** (SKILL.md is authoritative):

| Mode | Reflexion loops |
|---|---|
| `quick` | 1 |
| `standard` | 1 |
| `systematic` | 3 |
| `interactive` | CoVe on final claims |

`quick` mode runs the `audit` gate only, with a single reflection pass.
`systematic` runs three. If the threshold is not met at the max loop count,
proceed but flag the remaining issues explicitly to the user.

---

## 5.7 Output: 05-verification.md

Every count below comes from `bun $L stats` / `bun $L audit` — never
hand-counted.

```markdown
# Verification Results

## Summary
- Claims verified: N
- supported: N   partial: N   unsupported: N   contradicted: N

## Claim table
| Claim | Status | Action |
|---|---|---|
| CL001 RAG reduces hallucination 60%... | partial | narrowed to 20-50% on QA |
| CL002 attention is O(n^2)...           | supported | none |
| CL003 RLHF eliminates hallucination... | contradicted | revised to "reduces" |

## Contradicted — details
CL003: absolute claim; Ouyang 2022 (E031/E040) shows reduce-not-eliminate;
revised. Contradiction record: E031 vs E040 (direct).

## Unsupported — moved to gaps.md
CL015: no source for the 4x MoE figure. Impact: low (supporting detail).

## Self-refuting test
| Conclusion | Counter-evidence | Strength | Action |
|---|---|---|---|
| RAG most effective for hallucination | retrieval errors add new failures | moderate | qualified (partial) |

## Reflexion log
Loop 1: 7 errors (2 drift, 3 overgeneralization, 1 unsupported, 1 cherry-pick) — all addressed.
Loop 2 (systematic only): threshold met — exit.
```

**Quality gate — Stage 5 cannot advance to Stage 6 (Knowledge graph)
until:**

- [ ] Every claim has a `V###` verification status.
- [ ] Every `contradicted` claim has a matching `contradiction` record.
- [ ] Every `unsupported` claim is fixed, downgraded, or in `gaps.md`.
- [ ] The Reflexion loop finished at its per-mode count.
- [ ] The self-refuting test ran on the top conclusions.
- [ ] `bun $L audit --dir $R` was run mid-stage and its errors resolved.

---

## 5.8 Pipeline integration

| Input | Source | Purpose |
|---|---|---|
| `CL###` claims | `ledger.json` (stage 4) | What to verify |
| `E###` evidence | `ledger.json` | Ground truth for comparison |
| Mode | `00-brief.md` | Sets Reflexion loop count |
| `gaps.md` | file | Destination for `unsupported` claims |

| Output | Destination | Consumer |
|---|---|---|
| `V###` records | `ledger.json` | Stage 8 audit |
| Narrative | `05-verification.md` | Stage 6 (Knowledge graph) |
| Downgraded/dropped claims | `gaps.md` | Follow-up research |

Failure modes: synthesis too vague to extract claims → return to stage 4;
contradictions exceed ~30% of claims → flag for human review; Reflexion not
converging → exit at max loops and flag; VQ answers all inconclusive → mark
`unsupported`, likely thin source material.

The next stage is **Stage 6 — Knowledge graph** (not the report; the report
is Stage 7).
