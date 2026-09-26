# Stage 2 — Retrieval (HyDE + FLARE + the scholarly graph)

> **Wiring** · Tools: `<search>` + `<fetch>` (web leg); `scholar.ts search
> / cites / fetch / trend / dedup` (scholarly leg); then `ledger.ts add-source`,
> `ledger.ts mark-read`, and `ledger.ts log-query` for everything found. Fan
> out with `<subagent>`, one per sub-query, using the return contract in
> `references/executor-contract.md` — that file is canonical, do not restate
> it. Cache every fetched page to `$R/sources/S###.md` so quotes stay checkable.
> Contract: the generated block in `references/ledger.md` wins over this
> file on any count, threshold, filename, or tool name.

**The citable path — four commands per source.** Skipping the second is the
single most common way a run fails its audit, so it is repeated here rather
than left in `ledger.md`:

```bash
bun $L add-source   --file hits.json --from openalex   # metadata_at — a lead, not a source
bun $L mark-read    --source S001 --from-abstract      # read_at — NOW it is citable
bun $L screen       --source S001 --verdict include --criteria "C1:pass"
bun $L add-evidence --source S001 --question SQ1 --score 8 --summary "…" --quote "…"
```

`mark-read --all-from-abstract` does the second step for every unread source in
one call and names the ones with no usable abstract — those are your
`unobtainable` candidates.

**Leaving this stage** — `ledger.ts state` holds it open until: at least one
query is logged (`log-query`, including the zero-hit ones), sources are in the
ledger, **nothing is left metadata-only** (every one of those is uncitable),
`02-search-log.md` exists, and `gate --pass coverage` is recorded.

Stage 1 handed you sub-queries with routes. This stage retrieves the material:
HyDE for vocabulary discovery, FLARE for gap-driven iterative rounds, the
scholarly leg through `scholar.ts`, snowballing, dedup, a saturation check, and
— the load-bearing step — a `mark-read` pass that makes sources citable. It ends
at the coverage gate. Only four modes exist: `quick`, `standard`, `systematic`,
`interactive`. There is no "exhaustive" mode; deeper-than-standard work is
`systematic`.

This file is the method: §2.1–2.8. The API operations manual — which catalogue
to ask, snowballing mechanics, dirty metadata, rate limits — moved to
`references/02-apis.md`; open it when you work the scholarly leg, skip it on a
web-only run.

---

## 2.1 HyDE — Hypothetical Document Embeddings

**Concept.** A question and the document that answers it sit in different
embedding regions. HyDE bridges the gap by generating a hypothetical ideal
answer and searching with *that* instead of the raw question.

**How HyDE is actually executed here.** This skill's web leg uses `<search>`,
which is keyword-based — pasting a long hypothetical document into it retrieves
worse than the plain question. So generate the document as scratch reasoning
(never a source), extract 5–8 domain terms from it (technical vocabulary, method
names, entity names, units), and issue *those* as keyword queries. Use the full
document as a query only against a real vector index or a
`scholar.ts search --fulltext`. For the scholarly leg, prefer `scholar.ts
search` with the extracted terms — OpenAlex and Semantic Scholar match on title
and abstract text (`02-apis.md` §2.10).

**The numbers in a hypothetical document are invented** (non-negotiable 10).
They never reach a note, the ledger, or the report. Do not paste the document
into `02-search-log.md`; log the derived queries with `ledger.ts log-query`.

### When to use HyDE vs direct search

Prefer **HyDE** for "why"/"how"/conceptual/mechanism questions, comparative
("X vs Y") and multi-factor explanations, and emerging concepts with thin
vocabulary. Prefer **direct search** for specific named entities, exact quotes
or statistics, and historical events with known dates. Decision rule:
"why"/"how" → HyDE; "who"/"when"/a proper noun → direct. When uncertain, run
both and merge.

### Generation template

```markdown
Given the sub-query: "{sub_query}"
Write a hypothetical document that would perfectly answer it, as if you were the
author of an authoritative source (paper abstract, technical doc, or expert
report) addressing this question directly.
- 150–300 words, domain-specific terminology, target register
  (academic | technical | journalistic | policy).
- State findings plainly; do not hedge.
- No citations (this is a single hypothetical document).
Domain context: {domain_hint}
```

### Multilingual HyDE

When `--query-lang` names one or more languages other than English, generate a
hypothetical document **per language** and harvest terms from each:

```json
{
  "sub_query": "Tác động của biến đổi khí hậu đến nông nghiệp Việt Nam",
  "query_lang": "vi", "domain_langs": ["vi", "de", "ja", "ru", "en"],
  "hypothetical_docs": [
    { "lang": "vi", "doc": "Nghiên cứu đánh giá tác động của biến đổi khí hậu đến sản xuất nông nghiệp tại Việt Nam…" },
    { "lang": "de", "doc": "Auswirkungen des Klimawandels auf die vietnamesische Landwirtschaft…" },
    { "lang": "ja", "doc": "気候変動がベトナムの農業生産性に与える影響…" },
    { "lang": "ru", "doc": "Воздействие изменения климата на сельское хозяйство Вьетнама…" },
    { "lang": "en", "doc": "Climate change impacts on Vietnamese agricultural productivity, Mekong Delta rice yields…" }
  ]
}
```

Rule: one hypothetical document per language in `--query-lang`, plus English
(the dominant academic language) whenever it is not already in the list. Drop
a language for a given sub-query only when it plainly has no literature in
that domain — otherwise generate one document per configured language, however
many that is.

---

## 2.2 Query craft

Query craft lives here, not in stage 1 (stage 1 only decides *what* to ask).
Each sub-query becomes several concrete search strings; web and scholarly want
different shapes.

**Web search** rewards natural phrasing and specificity — the words someone who
knows the answer would type. Generate 2–3 variants per sub-query spanning
vocabularies (academic, industry, informal), 4–10 words each:

```
Primary:  microservices vs monolith deployment frequency comparison
Variant:  how often do microservice teams deploy compared to monoliths
```

Add year qualifiers for fast-moving facts (`… best practices 2026`, or
`after:YYYY-MM-DD`). Use `site:` for targeted source types (`site:arxiv.org`,
`site:github.com`, `site:*.gov`, `site:*.edu`).

**Scholarly search** rewards controlled vocabulary and Boolean structure. Use
field terminology, expand synonyms, and disambiguate acronyms:

```
("microservice architecture" OR microservices) AND ("deployment frequency" OR "release cadence")
("RAG" OR "retrieval-augmented generation")   # never bare "RAG" — collides with games
```

Avoid: single-word queries (too broad), whole questions (engines match
keywords), jargon-only (misses other communities' terms), too many terms at once
(over-constrains), and pasting the primary question verbatim. Split instead of
over-constraining.

Query language follows `--query-lang` (see §2.8). Log every issued query with
`ledger.ts log-query --lang <iso>`, naming the language that specific query was
issued in, so the ledger's record of language coverage does not depend on
anyone reading the query text back later.

---

## 2.3 FLARE — Forward-Looking Active REtrieval

**Concept.** FLARE retrieves at the moment a claim needs support rather than all
up front. Adapted here from token level to **claim level**: while drafting a
sub-query's findings summary, pause at any claim that needs support (a
quantitative assertion, a position attributed to an entity, a causal mechanism,
a contradiction of other sources, or the basis for a recommendation), turn it
into one precise query, search and fetch, then continue. If evidence supports
the claim, attach the source; if it contradicts, record both positions as a
contradiction lead; if nothing is found, mark the claim unsupported and flag it.

### Rounds by mode

| Mode | FLARE rounds | Max queries / round | Target sources |
|---|---|---|---|
| `quick` | 1 | 3–5 | 10–15 |
| `standard` | 2–3 | 5–10 | 25–40 |
| `systematic` | 3+ until saturation | 10–20 | 60+ screened |
| `interactive` | driven by the discourse | per turn | grows with turns |

Source targets track the `SKILL.md` mode table, which wins on any disagreement.

### The saturation test — three measures, not a feeling

The honest answer to "did you look hard enough" needs a test. Run all three
and record the result in `02-search-log.md`.

1. **New-source rate.** After each FLARE round compute `saturation_ratio =
   novel_relevant_sources / total_sources_this_round`, where a novel relevant
   source (a) was not already in the ledger, (b) survives the retrieval triage
   in §2.5, and (c) adds at least one claim or data point not already covered.
   - `< 0.10` → saturation reached; stop retrieval for this sub-query.
   - `0.10`–`0.25` → diminishing returns; one more round at most.
   - `> 0.25` → continue.
2. **Snowball closure.** Take your 5 best sources. Their reference lists and
   citing works should now be mostly things you already have. If a seed's
   references are still mostly unknown to you, you have not finished.
3. **Vocabulary closure.** Collect the keywords and OpenAlex topics from
   included sources. Any frequent term you never searched is an untested query
   — run it. This catches the case where the field's own term for the thing
   differs from yours.

Combine with a floor: do not stop below the mode's minimum source target even
if the ratio looks saturated early.

"Saturated at 41 sources after wave 3; snowball closure 87%; two untested
vocabulary terms remain, searched and yielded nothing new" is a reviewable
claim. "Searched thoroughly" is not.

---

## 2.4 Snowballing and iterative deepening

Citation snowballing is how you reach the primary literature that keyword search
misses — the single most productive retrieval move available, and one web search
cannot make. Route it through `scholar.ts`; the mechanics and the failure modes
are in `02-apis.md` §2.11.

- **Forward** (who cites this): `bun $S cites --id <W…|DOI> --direction citing`.
- **Backward** (what it cites): `bun $S cites --id <W…|DOI> --direction references`.

Snowball from high-value sources first. `quick` skips snowballing; `standard`
does one generation; `systematic` does two plus the saturation check. For each
generation, add returned records via the collect path in §2.6, then re-run the
saturation test.

Process executor-suggested follow-up queries by deduplicating against issued
queries, then prioritising: uncovered outline sections first, contradiction-
resolving queries next, deepening well-covered areas last — within the mode's
query budget. When the same query, reformulated three times, returns nothing
relevant, that is a **structural absence**: record it as a finding (the queries
tried and the conclusion) rather than continuing to hammer it.

---

## 2.5 Retrieval triage vs the ledger thresholds

While retrieving, you need a quick "keep or drop" judgement. That triage is
**not** the ledger's evidence score. Keep the two straight:

- **Triage** (retrieval only): decide what to carry into stage 3. Carry a
  source into screening if it looks clearly relevant; discard the obviously
  off-topic outright; note borderline background leads in `02-search-log.md`
  only, never as evidence. Triage is informal and lives in the search log.
- **Ledger evidence score** (stage 3, binding): set only by
  `ledger.ts add-evidence`, integer 1–10. The only thresholds that exist are
  **keep ≥ 6** (`add-evidence` refuses below) and **cite ≥ 7** (`audit` warns
  below). There is no "carry forward if ≥ 5" rule and no other cutoff. There is
  no 0–1 quality float, no source tier, and no confidence percentage anywhere
  in the ledger.

---

## 2.6 Collecting sources — and the citable path

This is the load-bearing part of stage 2, enforcing non-negotiable 1.

### The evidence tier

When the run is `--evidence-tier verified`, every `scholar.ts search` and
`cites` call carries `--peer-reviewed`, and the web leg is bound by the same
rule in `references/executor-contract.md`. The tier is not a mood: it was
written down as a criterion at stage 1, so stage 3 excludes against it with a
reason and the audit sees it. Filter mechanics per source are in
`02-apis.md` §2.9a.

### Executors do not assign ids

Executors write records to a file per `references/executor-contract.md` and hand
back its path. They must **not** invent `ledger_id` values. Ids are assigned by
the scripts: `scholar.ts dedup` assigns stable `S###` when it merges record
sets, and `ledger.ts add-source` assigns/reconciles them on ingest. Any `S001`
an executor writes is a placeholder; treat the id as unknown until a script
returns it.

```bash
# scholar output → dedup (assigns S### and reports duplicates) → add-source
bun $S dedup --in q1.json,q2.json --out corpus.json      # S### assigned here
bun $L add-source --dir $R --file corpus.json --from openalex   # sets metadata_at only
```

Deduplication is **reported by `scholar.ts dedup`'s own output** (precedence in
`02-apis.md` §2.12). There is no separate `deduplication_log` to maintain — read dedup's
stdout, and let `add-source` dedup again against the existing ledger.
`add-source` takes a lock on the ledger, so parallel executors merging at once
cannot overwrite each other's records.

### metadata_at is not reading — mark-read is

`scholar.ts` and `add-source` set `metadata_at`, which proves only that an API
returned a record. **`metadata_at` does not make a source citable.** A source is
citable only after `read_at` is set, and the *only* way to set `read_at` is
`ledger.ts mark-read`, which **refuses** unless the text is cached at
`$R/sources/S###.md` and is at least 200 characters. There is no `fetched`
field — it was removed.

Therefore **stage 2 must end with a `mark-read` pass over every source worth
screening.** Three paths, best first:

**Full text via the scholarly graph.** `scholar.ts fetch` resolves an
identifier to actual text — Europe PMC JATS, ar5iv for arXiv, the OA copy from
OpenAlex or Semantic Scholar, then Unpaywall — and writes it in the shape
`mark-read` wants:

```bash
bun $S fetch --id 10.1371/journal.pone.0266781 --out $R/sources/S002.md
bun $L mark-read --dir $R --source S002 --scope fulltext
```

It exits **3** when no full text exists, which is a fact about the source, not
an error: fall back to a page fetch or to the abstract. PDFs need `pdftotext`
(poppler) on PATH; without it the command tells you the URL so you can read it
with `<fetch>` instead. A run reuses the shared cross-run cache
(`ledger.ts cache`) automatically, so a DOI a previous run already fetched costs
nothing.

**Full text you fetched yourself.** Save the extracted text to the cache file,
then mark it read at full-text scope:

```bash
# after <fetch>, write the extracted text to $R/sources/S002.md, then:
bun $L mark-read --dir $R --source S002 --file $R/sources/S002.md --scope fulltext
```

**Abstract-only** — the abstract is your evidence. `--from-abstract` writes
`$R/sources/S001.md` from the stored abstract, then stamps `read_at`:

```bash
bun $L mark-read --dir $R --source S001 --from-abstract
```

For the abstract tier as a whole, one call does the pass and reports what it
could not do:

```bash
bun $L mark-read --dir $R --all-from-abstract
```

It stamps every unread source that has a usable abstract and names the ones
whose abstract is missing or under 200 chars — those are your `unobtainable`
screening candidates, or the sources to spend a `<fetch>` on.

Every path refuses if the cache file is missing or under 200 chars — that
refusal is the enforcement of non-negotiable 1. A source with `metadata_at` but
no `read_at` is a lead, not evidence, and `audit` rejects any citation to it.

**The abstract path has a cost, and it is now enforced** (non-negotiable 13).
`add-evidence` stamps the reading scope on every evidence record. A figure taken
from an abstract that goes on to back a claim is an `audit` error outside
`quick` mode, a figure in the report resting only on abstract-only sources is an
error outside `quick` mode, and in `systematic` mode an abstract-only record is
capped at score 6 — context, never a citation. Read the full text before you
quote a number.

### The full per-source order

The complete citable path is four commands per source (see
`references/ledger.md` "The citable path"): `add-source` (metadata_at) →
`mark-read` (read_at) → `screen` → `add-evidence`. Screening and evidence belong
to stage 3; the first two are stage 2's job. **Nothing leaves this stage without
a `read_at`.**

### Sources you cannot obtain

When a source is paywalled, 403s, times out, or is otherwise unobtainable, there
is **no `unfetchable_ledger` and no `U###` id scheme**. If it is already in the
ledger, exclude it with the vocabulary reason `unobtainable`:

```bash
bun $L screen --dir $R --source S007 --verdict exclude --reason unobtainable
```

If it never entered the ledger, note it in `02-search-log.md` (title, URL, why)
as a coverage limitation. Record the query either way:

```bash
bun $L log-query --dir $R --q "spaced repetition retention meta-analysis" \
  --source web --hits 15 --kept 3
```

---

## 2.7 Coverage gate

Before spending effort on screening, stop and review coverage with the user
(non-negotiable 8: report the search, not just the result). Every count comes
from `ledger.ts stats` — never hand-count. Present: sources found and after
dedup (from `stats`), a breakdown by kind and by outline-section coverage,
notable absences, contradiction leads, and any `unobtainable` exclusions. Then
choose one option.

Under `--evidence-tier verified`, also report **how much the tier removed** —
`scholar.ts` prints the count it dropped on every run. A corpus that shrank by
half is a fact about the evidence base and belongs in front of the user here,
not in a footnote at stage 8. If the tier has starved a sub-question, the fix
is to relax it now, with the user, rather than to write a thin section later.

| Option | Choose when |
|---|---|
| **Proceed to screening** | Outline coverage ≥ ~80% and saturation reached (ratio < 0.10) |
| **Run another wave** | Saturation not reached, specific gaps identified, budget remains |
| **Widen scope** | Core query well covered but adjacent areas unexplored and the user wants breadth |
| **Narrow scope** | Too many tangential sources diluting focus; prune sub-queries |

When the user is not in the loop, default forward: proceed if coverage is
adequate and saturated; run another wave if coverage is clearly low and budget
remains; narrow if the source count has run well past the mode target; otherwise
proceed with what you have. Coverage adequacy and saturation are the only two
signals — do not encode a decision tree beyond that.

Record the user's approval so a resumed run knows the gate is behind it:

```bash
bun $L gate --dir $R --pass coverage --note "proceed to screening, 41 sources"
```

In `quick` mode this gate merges with the stage-3 sufficiency gate into one
checkpoint. In `interactive` mode each roundtable turn is an implicit gate.

---

## 2.8 Language-aware retrieval

`--query-lang` sets query language and is a *set*, not a single value: `auto`
detects from the topic and, for a non-English topic, issues both
local-language and English queries (unchanged, two legs); `en` forces English
only; an explicit comma-separated list (e.g. `vi,de,ja,ru`) issues one leg per
listed language, plus an English supplement for technical gaps unless English
is already in the list. There is no cap on how many legs — five languages
means five legs (plus English) run the same way two would. Always keep English
as a fallback academic language regardless of how many other legs run. For
each non-English leg add that language's own journals, government statistics,
and research institutions where they exist (e.g. Vietnamese leg: Vietnamese
journals and institutions; German leg: German-language journals and
institutions; and so on). For the English leg, prioritise English but do not
exclude a highly relevant non-English source found along the way — note its
language and translate key findings alongside the original quote
(non-negotiable 9).

More languages means more queries and more fetches, so scope the leg count
against the run's `--mode` budget and `--sources` target (§SKILL.md table)
rather than running every leg to the same depth unconditionally — a `quick`
run with five query languages should still fit its ~25-search budget by
running each leg shallower, not by dropping legs silently.

A study appearing in several languages (e.g. a Vietnamese paper with an
English abstract) is still **one** source regardless of how many legs found
it: `scholar.ts dedup`'s normalised-title precedence collapses it across any
number of languages — keep the fuller-text version.

---

# The scholarly leg — API operations

Web search finds pages. The scholarly graph finds *published work* and the edges
between papers. Every call in this half was executed live against the API before
being written here; where behaviour differs from what the docs imply, the note
says so.

Run the leg through the script rather than raw HTTP — it handles backoff,
normalisation, and dedup:

```bash
bun $SKILL/scripts/scholar.ts --help
```

The raw filter vocabulary is documented anyway, because you will need to compose
filters the script does not wrap.

## What stage 2 produces

`02-search-log.md` (every query, via `log-query`) and the cached text under
`$R/sources/`; ledger sources carry `metadata_at` **and** `read_at` for
everything worth screening. The subagent return contract and a full executor
invocation example are canonical in `references/executor-contract.md` — not
repeated here. Then the coverage gate hands control to stage 3.
