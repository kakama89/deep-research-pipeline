# Stage 8 — Quality Gates and Final Audit

> **Wiring** · Mechanical on purpose. `ledger.ts audit --report` is the gate and
> must exit 0 before delivery; `ledger.ts stats` supplies every published count;
> `scholar.ts verify` checks that DOIs and URLs still resolve. Run the tools; do
> not redo their checks by hand. What no tool can judge — claim-to-source
> fidelity, quote fidelity, primary-source tracing, language consistency — is
> the manual half in §8.7, and the failure modes each check exists to catch are
> in §8.9. The gate is not the end: after the user has the report, continue to
> stage 9 (`references/09-learning-loop.md`).

**Leaving this stage** — `ledger.ts state` holds it open until `08-audit.md`
exists, `audit --report` exits 0, and `gate --pass audit` is recorded. In
`systematic` mode an unrecorded `coverage` or `sufficiency` gate is itself an
audit **error**, not a warning: the protocol is the deliverable there.

A report nobody checked is a report nobody should trust. Present the audit
alongside the report — including what it found against you.

## 8.1 The gate

Three commands, in order. The second must exit 0.

```bash
L="$SKILL/scripts/ledger.ts"
S="$SKILL/scripts/scholar.ts"
R="research/<slug>"

bun $L stats --dir $R  > $R/08-audit.md              # every published count
bun $L audit --dir $R --report >> $R/08-audit.md     # must exit 0
bun $S verify --in $R/ledger.json                    # do the links resolve?
```

`audit` without `--report` checks the ledger against itself and never opens the
deliverable. `--report` adds the report-level checks (8.3) and defaults to
`$R/REPORT.md` (case-sensitive). `audit` exits 1 if any error fires. Every
number in the report comes from `stats` — never hand-count, and paste
`stats --md` output so the audit can prove it:

```bash
bun $L stats --dir $R --md                           # the block REPORT.md carries
```

`audit --report` re-derives every number in that block from the ledger and
errors on any that was edited. It also validates `graph.json` when the file
exists, so a fabricated id in the knowledge graph fails the gate exactly like
one in the report.

## 8.2 Ledger-integrity checks

`audit` groups findings as **errors** (fix before delivery) and **warnings**
(resolve or disclose). Each row is one check string the tool emits, its
trigger, and what to do — the tool runs them, so do not redo them by hand.

### Claims and consensus

| Check | Sev | Trigger → what to do |
|-------|-----|----------------------|
| `claim-without-evidence` | error | A claim has no evidence ids. Add evidence or delete the claim; it cannot appear in the report. |
| `overstated-consensus` | error | `strong` with < 3 sources, or a single-source claim not labelled `thin`/`absent`. Add independent sources or downgrade the label. |
| `claim-on-weak-evidence` | warn | A claim rests partly on sub-7 evidence. Cite stronger evidence or soften the claim. |
| `possible-shared-authorship` | warn | A `strong`/`moderate` claim's sources share an author. Confirm independence or downgrade. |
| `single-venue-consensus` | warn | Every source (≥ 3) behind a claim shares one venue — one editorial filter. Diversify or downgrade. |
| `cited-but-unread` | error | Cited source has no `read_at`. Run `mark-read`, or drop the citation. |
| `cited-but-not-included` | warn | A cited source never passed screening. Screen it in or stop citing it. |

### The handovers

| Check | Sev | Trigger → what to do |
|-------|-----|----------------------|
| `gate-skipped` | warn, **error in `systematic`** | Evidence exists with no `scope` gate recorded, or a report exists with no `coverage` / `sufficiency` gate. The user never saw the criteria, the coverage, or the sufficiency call. Hold the gate now and record it (`ledger.ts gate --pass <name>`); do not back-date one that never happened. |

A gate is a conversation, so the tool can only notice that it never happened —
which is the point. Everything else in this file checks work you did; this
checks that the user was given the chance to redirect it while redirecting was
still cheap.

### Evidence

| Check | Sev | Trigger → what to do |
|-------|-----|----------------------|
| `orphan-evidence` | error | Evidence points at an unknown source id. Fix the reference. |
| `evidence-without-quote` | warn | No quote; its numbers are unverifiable. Add the verbatim quote. |
| `number-not-in-quote` | error | A number in the summary is absent from the quote. Fix the summary or quote it. (`add-evidence` now refuses this at source, exit 2, so this only fires on records made before that rule or edited by hand.) |
| `figure-from-abstract` | error, warn in `quick` | Evidence backing a claim takes a number from an abstract-only source. Fetch the full text (`scholar.ts fetch`) and re-read at `--scope fulltext`, or drop the figure. |
| `no-locator` | warn | Citable evidence (7+) has no locator. Add `§`/page. |
| `no-scope-note` | warn | Citable evidence records no scope conditions. Add `--scope-note`. |

### Sources

| Check | Sev | Trigger → what to do |
|-------|-----|----------------------|
| `suspect-metadata` | error if included, else warn | Source carries anomaly flags. Verify against the publisher page; drop if wrong. |
| `retracted-included` | error | A retracted source is marked included. Exclude it. |
| `included-but-unused` | warn | Included source produced no evidence. Extract evidence or reconsider. |
| `included-but-unfetched` | error | Included but has no `metadata_at`. Fetch or exclude. |
| `included-but-unread` | error | Included but never read. Run `mark-read`, or exclude as `unobtainable`. |
| `cache-missing` | error | Read but `sources/S###.md` is gone — quotes uncheckable. Restore the file. |
| `abstract-only-in-systematic` | warn | Abstract-only inclusion in `systematic` mode. Fetch full text. |

### Matrix, contradictions, questions, log

| Check | Sev | Trigger → what to do |
|-------|-----|----------------------|
| `matrix-hole` | warn | Included source has no value for a column. Fill it (`not reported`/`inferred:`). |
| `cell-without-quote` | warn | Extraction cell has no quote and is not marked inferred/not-reported. Add or mark. |
| `orphan-contradiction` | error | Contradiction references unknown evidence. Fix the id. |
| `question-thin` | warn | A sub-question has no evidence at 7+. Apply the refusal rule, do not write a weak answer. |
| `no-criteria` | warn | No criteria registered — screening unreviewable. Register criteria. |
| `no-search-log` | warn | No queries logged — coverage unreviewable. Use `log-query`. |

### Verification (stage 5, CoVe)

| Check | Sev | Trigger → what to do |
|-------|-----|----------------------|
| `orphan-verification` | error | A verification points at an unknown claim or cites unknown evidence. Fix the id. |
| `claim-failed-verification` | error | A verification is `unsupported`. Fix, downgrade, or move to `gaps.md` — it cannot ship. |
| `contradiction-not-recorded` | error | A verification is `contradicted` but no contradiction record covers it. Record it. |
| `claim-unverified` | warn | (Only when verification exists.) A claim has no verification question. Verify it. |

### Access bias

Not "is this evidence sound" but "what is this evidence base missing by
construction". A corpus assembled from what happened to be free is not a corpus
of what is known, and the funnel is the only place that shows it. Both are
warnings: the fix is disclosure, not a different literature.

| Check | Sev | Trigger → what to do |
|-------|-----|----------------------|
| `access-bias-unobtainable` | warn | ≥ 15% of screened sources (and ≥ 3) were excluded as `unobtainable`. Say so in the report, and list the paywalled leads in `gaps.md`. |
| `access-bias-abstract-only` | warn | ≥ 50% of included sources were read as abstracts only. Try `scholar.ts fetch` on them; where no OA copy exists, state the limit and keep figures off them. |

### Knowledge graph (stage 6)

`graph.json` is written directly rather than through a ledger command, which
left it as the one artefact whose ids nobody checked. `audit` now reads it when
it exists (`--graph PATH` to point elsewhere, `--no-graph` to skip).

| Check | Sev | Trigger → what to do |
|-------|-----|----------------------|
| `graph-unparseable` | error | `graph.json` is not valid JSON. Rewrite it; it is regenerable. |
| `graph-empty` | error | The file holds no nodes. Build the graph or delete the file. |
| `graph-bad-id` | error | A `ledger_ids` entry is not an `S###`/`E###`/`CL###`/`V###` id. Use real ledger ids; a local node key is not one. |
| `graph-unknown-id` | error | A `ledger_ids` entry is not in the ledger — a fabricated id. Remove or correct it. |
| `graph-excluded-source` | error | A node or edge traces to a source that did not pass screening. |
| `graph-unread-source` | error | A node or edge traces to a source that was never read. |
| `graph-node-without-id` | error | A node has no `id`; edges cannot reference it. |
| `graph-edge-endpoint-missing` | error | An edge has no `source` or `target`. |
| `graph-dangling-edge` | error | An edge points at a node that does not exist in the file. |
| `graph-without-ledger-id` | warn | A node or edge carries no `ledger_ids`. Attach the evidence it rests on, or drop it — an unsourced node is a hunch drawn as a fact. |
| `graph-count-mismatch` | warn | `metadata.node_count`/`edge_count` disagrees with the arrays. Regenerate. |

## 8.3 Report-level checks (`--report`)

Everything above checks the ledger against itself; none of it can tell whether
the deliverable actually cites what the ledger holds. `--report` opens
`REPORT.md` and adds:

| Check | Sev | Trigger → what to do |
|-------|-----|----------------------|
| `report-missing` | error | `--report` file does not exist (case-sensitive `REPORT.md`). Write it, or fix the path. |
| `report-uncited` | error | The report contains no `[S###]` citation at all. Cite the sources. |
| `citation-unknown-id` | error | The report cites an id not in the ledger — a fabricated citation. Remove or correct it. |
| `citation-to-excluded-source` | error | The report cites a source that did not pass screening. Screen it in or drop the citation. |
| `citation-to-unread-source` | error | The report cites a source that was never read. Run `mark-read` or drop the citation. |
| `claim-absent-from-report` | warn | A non-`absent` claim is in the ledger but none of its sources are cited in the report. Restore the finding or delete the claim. |
| `figure-without-citation` | error | A paragraph states a figure and cites nothing in the same paragraph. Add the citation. |
| `report-figure-from-abstract` | error, warn in `quick` | A figure in the report rests only on sources read as abstracts. Read the full text, or drop the figure. In `quick` mode it is a disclosure, not a defect — say so in the report. |
| `section-without-citation` | warn | A `##` section runs > 400 chars with no citation. Cite it, or confirm it is intro/method (observation vs inference). |
| `no-currency-line` | error | No "Evidence current as of <date>" line. English and Vietnamese phrasings are matched natively; in any other output language put `<!-- drp:as-of YYYY-MM-DD -->` beside the line, and mark the reference list with `<!-- drp:references -->` so its ids are not read as citations. |
| `stats-block-stale` | error | A count inside the `<!-- drp:stats -->` block disagrees with the ledger. Regenerate with `stats --md`; never hand-edit a count. |
| `stats-block-unparseable` | error | The block's payload is not valid JSON. Regenerate it rather than repairing it. |
| `stats-block-unterminated` | error | The block has no closing `<!-- /drp:stats -->`. Paste the whole block. |
| `no-stats-block` | warn | The report has no counts block at all, so its funnel numbers are unchecked. Paste `stats --md` output. |
| `stats-block-unknown-key` | warn | The block declares a key `stats --md` does not produce. Regenerate. |

## 8.4 `scholar.ts verify` — the link check

`scholar.ts verify --in $R/ledger.json` re-requests every DOI and URL and
reports what no longer resolves. Its result is **four-valued, and only one
value is a finding**:

| Outcome | Meaning | Counts as |
|---------|---------|-----------|
| `ok` | DOI is registered, or the URL returned 2xx/3xx | verified |
| `dead` | DOI unregistered, or URL returned 404/410 | **a failure — fix or flag it** |
| `blocked` | 401/403/429 — the publisher refuses automated requests | inconclusive |
| `unreachable` | timeout or network failure | inconclusive |

Do not report `blocked` or `unreachable` as broken links; publishers block bots
routinely and a false "this source is gone" is worse than no check. DOIs are
checked against the DOI Handle API — authoritative about registration and immune
to blocking; sources without a DOI fall back to a URL check and show `blocked`
more often, so list those in the "not verified" block and open the ones that
matter by hand.

## 8.5 Severity and the gate

| Level | Meaning | Action |
|-------|---------|--------|
| **error** | Affects the reliability of the conclusions | Must be fixed before delivery. `audit` exits 1. |
| **warning** | Minor, or needs a judgement the tool cannot make | Resolve, or disclose to the user by name at the gate. |

The hard gate is `audit --report` exiting 0. If an error is genuinely
unfixable, name it to the user rather than hiding it. Accepted warnings must be
disclosed, not silently cleared.

## 8.6 Presenting the result — the gate

Show the report, the audit output, and `gaps.md` together — never a report
without its audit. Append the summary to `REPORT.md`; publish it even when it is
unflattering.

```markdown
## Appendix: audit
**Run**: <date>   **Tools**: `ledger.ts audit --report`, `scholar.ts verify`
- Errors: 0 (gate passed).  Warnings: <n> — <one line each, or "none">.
- Links: <n> ok, <n> dead (fixed/flagged), <n> inconclusive (blocked/timeout).
- Manual (§8.7): <what was spot-checked and the outcome, passes included>.
- Corrections made: <e.g. CL07 downgraded strong → moderate: shared dataset>.
- Not verified: <paywalled abstracts only; blocked/timeout locators — [S004]…>.
```

State what you could not verify rather than letting the audit imply full
coverage.

## 8.7 The manual half — checks no tool can make

`audit` cannot open a source and read it. After the gate passes, work through
these and record the outcome of each in the appendix, **including the ones that
passed**. An audit that only lists failures cannot be told from one that was
never run.

1. **Claim-to-source fidelity.** Sample at least 5 claims, or every claim in
   `quick` mode. Open `$R/sources/S###.md`. Does the source actually say that,
   under the conditions stated? This is the check that catches the most real
   errors.
2. **Number provenance.** Every figure in the report: does it appear verbatim
   in a quote in its evidence record? Digit by digit. The tool compares tokens;
   you are checking that the number means what the prose says it means.
3. **Quote fidelity.** Sample 5 quotes against the cached text. No silent
   paraphrase, no ellipsis that changes the meaning, no dropped qualifier.
4. **Primary-source tracing.** For the claims that matter most, is the citation
   the study that made the measurement, or a paper repeating someone else's?
   Untraceable ones must be labelled `secondary-source-only`.
5. **Independence of `strong` labels — confirm the tool's judgement.** `audit`
   pre-warns `possible-shared-authorship` and `single-venue-consensus`. It
   cannot settle either. For each warning, and for any `strong` label it did
   *not* flag, confirm by eye: shared affiliations or a shared dataset also
   collapse "independent" sources into one, and neither is visible to the tool.
   Downgrade the label where independence does not hold.
6. **Disclosure completeness.** Every vendor-published, sponsored, preprint, and
   retracted source labelled at its first mention in the body *and* in the
   reference list. (A retracted *included* source is already blocked by
   `retracted-included`; this check is about the labels being present, not about
   catching a retraction the tool missed.)
7. **Contradictions surfaced.** Every contradiction in the ledger appears in the
   report. None quietly dropped because it complicated the story.
8. **Gaps honest.** Every insufficient-evidence question appears in the report
   and in `gaps.md`. No gap papered over with adjacent material.
9. **Counts match the tool.** Every number in the prose equals `ledger.ts
   stats`. Where the prose and the tool disagree, the tool is right.
10. **Inference fenced.** Nothing unsourced sits in a findings section
    (non-negotiable 7).
11. **Language consistency.** Deliverables in `--output-lang`; quotes in the
    original language with a translation alongside, never instead.

## 8.8 Handing over

The deliverable is the directory, not just `REPORT.md`. Tell the user where it
is and that `ledger.json` traces any claim; the audit result with corrections
and what went unverified; the top 2-3 gaps and what would close them; which
facts have a short shelf life and roughly when to recheck. `gaps.md` plus
`02-search-log.md` let someone resume without this conversation, and
`ledger.ts state` tells them which stage the run stopped at. Then continue to
stage 9 — do not offer to extend the research unless asked; `gaps.md` already
says what extending would involve.

## 8.9 Failure modes

Each of these has produced a wrong report before. The fix is the point; the
right-hand column is why most of the checks above exist.

| Failure | How it looks | Fix |
|---------|--------------|-----|
| **Snippet citing** | Citation points at a page that never made the claim | Read before citing. `mark-read` refuses without cached text |
| **Hallucinated identifiers** | A plausible DOI or arXiv id that resolves to nothing, or to something else | `scholar.ts verify`. Never compose an identifier from memory |
| **Corrupt catalogue record** | Authoritative-looking metadata merging two works: real authors and citation count under the wrong title and year | `scholar.ts` anomaly flags; confirm title, year, and authors against the publisher page. See `02-apis.md` §2.13 |
| **False dead links** | Live sources reported as broken because the publisher answered 403 | Treat `blocked`/`unreachable` as inconclusive, never as dead |
| **Citation laundering** | B says "X [A]"; you cite B; A does not say X | Trace to the measuring study or label `secondary-source-only` |
| **Fake consensus** | Five citations, one lab, one dataset | Tool pre-warns `possible-shared-authorship` / `single-venue-consensus`; confirm authors, affiliations, and dataset before any `strong` label |
| **Averaging conflicts** | A number no source reports | Report both sides with their conditions |
| **Scope stripping** | "34ms" without the hardware or candidate count | `scope_note` on every evidence record; carry it into the prose |
| **Abstract-only numbers** | Figure from the abstract differs from Results | `figure-from-abstract` and `report-figure-from-abstract` are audit errors; take numbers from Results |
| **Preprint conflation** | Preprint presented as peer-reviewed | Label preprints; check for a published version |
| **Vendor laundering** | Vendor benchmark cited as independent | `interest_disclosure` on every source; label in body and references |
| **Stale facts** | Prices, versions, rankings from three years ago | Date everything; list short-shelf-life facts in `gaps.md` |
| **Retraction blindness** | Citing withdrawn work | `is_retracted:false` in every OpenAlex filter; `retracted-included` blocks it from shipping |
| **Vocabulary lock-in** | Whole subliterature missed because it uses a different term | Vocabulary closure test; S2 recommendations for keyword-free retrieval |
| **Language blind spot** | English-only search presented as complete | Say which languages were searched and what that misses |
| **Criteria drift** | Criteria quietly adjusted to fit what was found | Pre-register; `add-criterion` refuses a silent rewrite, so amendments are visible |
| **Positive-result skew** | Nothing found that failed to replicate | Search failure explicitly: "no effect", "failed replication", "negative result" |
| **Confirmation drift** | Report agrees with the framing it started from | Mandatory adversarial perspective; forward citation traversal for refutations |
| **Recency bias** | Only 2025-2026 sources on a 30-year question | Include foundational work regardless of age; check the year histogram |
| **Gap papering** | A thin section filled with adjacent material | Refusal rule. An honest gap beats a padded section |
| **Count drift** | Prose says 38, ledger has 37 | All counts from `ledger.ts stats` |
| **Ledger rot** | Report cites ids the ledger no longer has | `audit --report` before every delivery — it errors `citation-unknown-id` |
| **Lost records** | The funnel count is short and nobody can say why | Parallel writers take a lock; never edit `ledger.json` by hand |
