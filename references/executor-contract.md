# Stages 2 and 3 (web leg) — Query Planning and Parallel Execution

This is **GPT Researcher's** contribution: split the work into a planner
that decides what to ask and executors that go and read. The planner
never reads pages; the executors never decide scope. That separation is
what keeps a wide search from drifting off-topic.

The other half of GPT Researcher's design matters just as much: executors
**scrape and read whole pages**, then return summaries attributed to
sources. They do not return search-result snippets. Snippet-grounded
reports are how citations end up pointing at pages that never made the
claim.

## 2.1 Decompose into sub-queries

Input: `00-brief.md` (sub-questions, perspectives) and `01-plan.md`
(sections with `thin`/`empty` status).

Write sub-queries that are:

- **Independently searchable.** Each must stand alone in a search box.
  No pronouns, no "the above", no dependency on another sub-query's
  result.
- **Non-overlapping.** Two sub-queries returning the same 8 pages is
  wasted budget. If two overlap, merge them or narrow one.
- **Outline-covering.** Every `thin` or `empty` section needs at least
  one sub-query aimed at it. Map them explicitly.
- **Answerable by a document that exists.** "What is the optimal X" has
  no document. "What tradeoffs do practitioners report when choosing X
  over Y" does.

Counts by mode: `quick` 3-5, `standard` 6-10, `systematic` 10-20,
`interactive` rolling (generated per turn).

For each sub-query record the route, because source type determines which
API to use:

```markdown
| ID | Sub-query | Route | Targets section | Source-type priority |
|----|-----------|-------|-----------------|----------------------|
| Q1 | "<phenomenon> production failure modes post-mortem" | web | §3 | practitioner reports, incident write-ups |
| Q2 | "<phenomenon> latency benchmark evaluation" | scholarly + web | §4 | peer-reviewed, benchmarks |
| Q3 | "<phenomenon> systematic review" | scholarly | §1 | reviews, surveys |
| Q4 | "<vendor> <phenomenon> pricing 2026" | web | §5 | vendor docs — mark as vendor-sourced |
```

Routes: `web` (`<search>` + `<fetch>`), `scholarly`
(`scholar.ts` — see `references/02-apis.md`), or both. Send
anything with a publication record to the scholarly route; it gives you
citation counts, DOIs, and snowballing that web search cannot.

## 2.2 Query craft

Each sub-query becomes several concrete search strings. Web search and
scholarly search want different shapes.

**Web search** rewards natural phrasing and specificity: the terms a
person who knows the answer would use. Generate 2-3 variants per
sub-query, spanning vocabularies (academic term, industry term, informal
term). Add year qualifiers for fast-moving facts. Add `site:` or file-type
qualifiers when hunting a specific document class (standards, RFCs, SEC
filings, post-mortems).

**Scholarly search** rewards controlled vocabulary and boolean structure:
- Cover synonyms and acronyms explicitly — the literature will not
  normalise them for you (`"retrieval augmented generation" OR "RAG"`).
- Watch for acronym collisions and add a disambiguating term.
- Use British and American spellings both.
- Prefer title/abstract-scoped search over full-text search for
  precision; full-text search is for recall sweeps.
- Add negative terms only after you have seen what the noise actually is.

**Anti-patterns:** loading a query with every keyword at once (returns
nothing), one-word queries (return everything), and reusing the user's
exact phrasing when the field uses different terminology.

Log every query string as it is issued, including the ones that returned
nothing. Zero-hit queries are evidence about the field.

## 2.3 Executor fan-out

One `<subagent>` call per sub-query, general-purpose role,
run in parallel. Independent calls go in one block.

**Executors return a file path, not the findings themselves.** The full
record set for one sub-query runs to thousands of tokens; ten of those
arriving as tool output is a large fraction of the context window spent on
data that `ledger.ts` is about to read from disk anyway. The executor
writes its JSON into the research directory and hands back a receipt. You
read the receipt; the ledger reads the file.

Give each executor a self-contained prompt. It has none of your context:

```
Research this specific question, write your findings to the file named
below, and reply with the receipt block only.

QUESTION: <sub-query text>
CONTEXT: This supports a larger review of <topic>. You only need to
answer this one question.
TIME WINDOW: <window>. Prefer sources published after <date>.
SOURCE PRIORITY: <ranked source types>
BUDGET: search 2-4 times, fetch and read 3-6 pages in full.
OUTPUT FILE: research/<slug>/raw/executor-Q1.json   (create directories as needed)

RULES
1. Use <search> to find candidates, then <fetch> to read the
   promising ones IN FULL. A search snippet is a lead, not a source.
   Never report a finding you only saw in a snippet.
2. One record per source you actually fetched. If a fetch failed, say so
   in unfetchable, do not report its content.
3. Quotes must be verbatim from the fetched page. Never paraphrase into
   the quote field.
4. Every number, date, price, version, or benchmark result needs a quote
   containing it.
5. relevance is 1-10 for how directly this source answers THE QUESTION
   ABOVE, not how good the source is in general.
6. Note when a source is vendor-published, sponsored, or otherwise
   interested in the answer.
7. If you cannot find real support, write a file with an empty sources
   array and explain in coverage_notes. An empty result is a valid,
   useful answer. Do not fill the gap from your own knowledge.

WRITE EXACTLY THIS JSON to the output file, nothing else in it:
{
  "sub_query": "<the question>",
  "queries_issued": [{"q": "...", "engine": "web", "hits": 0}],
  "sources": [
    {
      "title": "...",
      "url": "...",
      "publisher": "...",
      "author": "... or null",
      "published": "YYYY-MM-DD or YYYY or null",
      "accessed": "YYYY-MM-DD",
      "kind": "peer-reviewed|preprint|standard|vendor-doc|practitioner|news|blog|dataset",
      "interest_disclosure": "independent|vendor-published|sponsored|unclear",
      "relevance": 8,
      "summary_wrt_question": "2-4 sentences answering ONLY the question above",
      "quotes": [{"text": "verbatim ...", "locator": "section or heading"}]
    }
  ],
  "findings": [
    {"claim": "one sentence", "supported_by": ["url1"], "confidence": "high|medium|low"}
  ],
  "contradictions_seen": [
    {"claim_a": "...", "source_a": "url", "claim_b": "...", "source_b": "url"}
  ],
  "unfetchable": [{"url": "...", "reason": "paywall|404|blocked|timeout"}],
  "coverage_notes": "what you could not find, and what you would search next",
  "follow_up_queries": ["specific queries this work suggests"]
}

THEN REPLY WITH ONLY THIS, no prose around it:
FILE: <the path you wrote>
SOURCES_READ: <how many sources you fetched in full>
UNFETCHABLE: <count>
QUERIES: <comma-separated "query string"=hits, every query you issued>
TOP: <the single most useful source's title and url, one line>
COVERAGE: <one or two sentences: what is missing, what you would search next>
FOLLOW_UP: <up to 3 queries this work suggests, semicolon-separated>
```

The file contract is strict because free-form returns cannot be merged
into a ledger; the receipt is strict because it is what you actually plan
on. `unfetchable` plus `COVERAGE` are what let you tell a genuine absence
of evidence from a failed search.

**Under `--evidence-tier verified`, tell the executor so, in its brief.** It
may then return only `"kind": "peer-reviewed"` sources. Everything it found and
had to leave behind goes into `coverage_notes` with a count — a tier that
quietly empties a sub-query looks identical to a topic nobody has written
about, and the two demand opposite responses. An executor that returns another
`kind` under that tier has broken the contract; drop the record rather than
screening it out later.

If an executor replies with the JSON inline instead of a path, do not
paste it forward — write it to `raw/executor-Q<n>.json` yourself and carry
on from the file. If the file it names does not exist, treat the sub-query
as unrun rather than trusting the summary of a file nobody wrote.

## 2.4 Merge into the ledger

Read each receipt, then let the ledger read the files. You do not need to
open the JSON yourself; `add-source` reports what it did with it.

```bash
L="$SKILL/scripts/ledger.ts"
R="research/<slug>"
bun $L add-source --dir $R --file $R/raw/executor-Q1.json --from web
```

`add-source` accepts the contract above directly, maps `published` to a
year and `accessed` to the fetch date, dedups against what the ledger
already holds, and never re-issues an id. It is safe to run several in
parallel — the ledger takes a lock, so two executors' records cannot
overwrite each other. It reports how many were added versus merged, and
warns about anything arriving without a fetch date; those are not citable.

What the merge still needs from you, per record:

1. **Dedup judgement.** The tool matches URL, DOI, then normalised
   title + year. Same source from several executors: it keeps one record,
   unions the quotes, keeps the highest relevance, and records every
   sub-query that found it. Independent rediscovery is a signal worth
   keeping.
2. **Drop unfetched sources.** Anything in `unfetchable` is logged in
   `02-search-log.md` and never cited.
3. **Keep `interest_disclosure`.** A vendor benchmark showing the vendor
   winning is still evidence, but the report must say who published it.
4. **The reading pass.** An executor's fetch is not this run's cached
   text. Nothing is citable until the text sits at `sources/S###.md` and
   `mark-read` has stamped it — see `02-retrieval.md` §2.8.

Then log every query from the `QUERIES` line of each receipt, including
the ones that returned nothing, so coverage is reviewable:

```bash
bun $L log-query --dir $R --q "<query string>" --source web --hits 42 --kept 6
```

`02-search-log.md` is written from these records.

## 2.5 Iterate: breadth and depth

GPT Researcher runs the loop more than once. After the first wave:

- **Coverage check.** Any outline section still `thin` or `empty`? Write
  new sub-queries aimed only at those, using the vocabulary the first
  wave taught you. This second wave is usually much better targeted than
  the first, because you now know the field's terms.
- **Depth pass.** For findings that matter most to the primary question,
  go deeper: chase the sources those sources cite, find the primary study
  behind a secondary report, look for the counter-argument specifically.
- **Follow-ups.** Executors return `follow_up_queries`. Triage them
  against the outline and promote the ones that hit thin sections.
- **Contradiction leads.** Anything in `contradictions_seen` gets a
  targeted query to find out which side has better support.

Wave counts: `quick` 1, `standard` 2, `systematic` 3+ until saturation
(see the saturation test in `references/02-retrieval.md` §2.3).

## 2.6 Stop conditions

Stop widening when any of these holds, and say which one in the report:

- **Saturation.** A full wave returns almost no new sources that clear
  the relevance threshold.
- **Budget reached.** The mode's source target is met and every outline
  section is `covered`.
- **Structural absence.** Repeated well-formed queries return nothing.
  That is a finding — the literature does not address it. Write it in
  `gaps.md` rather than padding with loosely related material.

Do not stop merely because you have enough material to write something.
The question is whether the material answers the question that was asked.

## 2.7 Coverage gate

End of stage 3. Present, using `ledger.ts stats` for every number:

- Sources found, deduped, by kind, by year, by interest disclosure.
- Outline coverage: sections `covered` / `thin` / `empty`.
- Notable absences and how hard you looked.
- Contradiction leads worth resolving.
- What screening will cost from here.

Then offer: proceed to screening, run another wave on the thin sections,
widen the scope, or narrow it.
