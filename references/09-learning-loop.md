# Stage 9 — Learning Loop

> **Wiring** · Tools: `bun $M show` at the start of every run (stage 1) and
> `bun $M add` / `replace` / `compact` at the end (stage 9), where
> `$M = "$SKILL/scripts/memory.ts"`. State lives
> in `$SKILL/memory.md` — skill level, not inside
> `research/<slug>/`, because its whole purpose is to outlive one run.
>
> **Input**: a finished run that has passed the audit gate.
> **Output**: zero or more entries in `memory.md`. Zero is a normal, correct
> outcome.

**Leaving this stage** — ask **once** what to remember, then record
`gate --pass memory`. A blank answer, "no", or silence writes **nothing**: no
file, no empty section, no record of the asking. `memory.ts add` exits 2 on
blank input and on a near-duplicate, which is the tool agreeing with you rather
than a failure to retry around. `memory.ts show` reports the store's format
version; a `memory.md` written by a newer build is read but never rewritten.

---

## 9.1 Why this stage exists

Everything else in this pipeline is designed to forget. The ledger is
per-run, the research directory is per-run, and that is deliberate: evidence
must not leak between questions. But *process* knowledge is worth keeping.
That the user wants Vietnamese prose with English technical terms. That
OpenAlex has thin coverage of a particular field. That vendor whitepapers
flood page one for a given class of query. None of that is a finding, and
none of it needs a citation — it is knowledge about how to research well for
this user.

Stage 9 captures exactly that, and nothing else.

## 9.2 The hard line: memory is not evidence

`memory.md` carries no source, no quote, no access date, and no audit. So a
memory entry can never become a claim.

| Allowed in memory | Never in memory |
|---|---|
| "User wants Vietnamese prose, English technical terms" | "RAG cuts hallucination by 60%" |
| "OpenAlex abstracts are sparse for Vietnamese agriculture; add VJOL" | "The Mekong Delta lost 8.3% rice yield" |
| "Vendor whitepapers dominate LLM benchmark queries; exclude at stage 1" | "Vendor X is faster than vendor Y" |
| "`--fulltext` on scholar.ts was noisy for this domain" | "Study S014 was retracted" |
| "User calls this 'độ trễ' not 'latency'" | any number, any percentage, any date as data |

If a candidate entry would need a `[S###]` next to it to be honest, it does
not belong in memory. Put it in the report, or in `gaps.md`.

At the start of the next run, memory may change *how* you search — which
sources you reach for first, which criteria you propose, which language you
write in. It may never supply a fact, shorten the search, or excuse a
citation. A remembered lesson is a hint, not a shortcut.

## 9.3 The ask

Run this after the audit gate, once the user has the report. Ask once, in
`--interaction-lang` (which defaults to `--output-lang`), and keep it to two
sentences:

> Anything you want me to remember for next time? For example a language or
> format preference, a source that worked well or badly, or a dead end to
> avoid. Leave it blank to skip — nothing is saved by default.

Three things matter about the wording:

1. **Give examples of the right category.** Without them, users offer
   findings ("remember that RAG cuts hallucination by 60%"), which you must
   then refuse. Examples steer them to process knowledge.
2. **State the default out loud.** "Nothing is saved by default" is the
   honest description of the blank rule, and it stops the user feeling
   obliged to produce something.
3. **Ask once.** Do not re-prompt, do not offer suggestions of your own to
   fill the silence, do not save "the run went well".

## 9.4 The blank rule

If the user leaves the answer blank, says nothing, says "no", "không",
"skip", "nah don't bother", "thôi khỏi", "not this time", or otherwise
declines, **write nothing at all**. Do not create `memory.md`. Do not append
an empty section. Do not record that the user was asked and declined.

`memory.ts add` enforces this in code: empty input, whitespace-only input,
and short conversational refusals exit 2 and leave the file untouched. The
refusal test only applies to short input, so a real lesson that happens to
begin with a refusal word — "Không dùng Semantic Scholar khi thiếu API key" —
is stored normally. Exit 2 means "nothing to do by design"; it is not a
failure and you do not retry it.

Confirm briefly and end the run:

> Nothing saved.

## 9.5 Semantic compaction — your job, before you call `add`

The user's answer arrives as prose about this run. What goes into memory has
to be a lesson that applies to the *next* run. Six operations, in order:

**1. Split.** One answer often contains several lessons. Split them, one
`add` call each. "Write in Vietnamese and stop using Semantic Scholar, it
kept failing" is two entries: a `preference` and a `source`.

**2. Strip the run.** Remove everything specific to this question. "For this
LLM benchmark review, vendor whitepapers were useless" becomes "Vendor
whitepapers dominate benchmark queries; exclude at stage 1". The lesson has
to fire on a question you have not seen yet.

**3. Generalise, but only one step.** Widen from the instance to the
pattern, not to a platitude. "Semantic Scholar returned 429 without a key"
generalises to "Semantic Scholar needs `SEMANTIC_SCHOLAR_API_KEY`; the
keyless tier fails under load" — useful. It does not generalise to "APIs are
unreliable" — worthless.

**4. Make it actionable.** An entry should imply an action at a named stage.
Prefer "add a `vendor-marketing` exclusion criterion at stage 1" over
"vendor content is a problem". If you cannot name what you would do
differently, the lesson is not ready; ask the user one clarifying question
or drop it.

**5. Merge against what is already there.** Run `bun $M show` first. If the
new lesson refines an existing entry, do not add a second entry — rewrite the
existing one with `replace --match "…" --text "…"` so the file holds one
sentence per lesson. `add` will refuse a near-duplicate anyway (exit 2), so
this is the difference between a clean merge and a rejected write.

**6. Classify.** Pick one kind. If two fit, the entry is probably two
entries — go back to step 1.

**7. Normalise the language.** Write `preference`, `scope`, `source`,
`method`, and `pitfall` entries in **English**, whatever language the run was
conducted in. These describe *behaviour* — a stage to change, a source to
reach for, a trap to avoid — and stage names, flags, and API names are already
English, so an English sentence stays greppable and mergeable across runs
regardless of the user's language. This is a normalisation, not a translation
of findings: the lesson's meaning is unchanged, only its wording is regularised.

Two things are **never** anglicised:

- **`terminology` entries stay in the user's language** — the whole lesson is
  which word the user uses. `"User calls latency 'độ trễ'"` keeps `độ trễ`; a
  translated version would erase the fact being remembered.
- **A user's own term quoted inside another kind stays in the original.**
  `"For the Mekong Delta ('Đồng bằng sông Cửu Long') scope to provinces, not the whole basin"`
  keeps the Vietnamese in quotes — you are recording their vocabulary, not
  restating a finding.

If a `preference` *is itself* about language ("write reports in Vietnamese"),
the entry is English prose describing that preference — the sentence
`"Write reports in Vietnamese; keep technical terms in English"` is already in
the right form.

| Kind | For |
|---|---|
| `preference` | Output language, format, tone, level of detail, report length |
| `scope` | How this user frames questions; date windows; what they consider in or out |
| `source` | Which databases, journals, or sites paid off or disappointed, and for what |
| `method` | Which pipeline settings worked: mode, HyDE vs direct, snowball depth |
| `pitfall` | Recurring traps: source types to exclude, metadata quirks, dead ends |
| `terminology` | The user's preferred term for a concept, in their language |

Then write it as **one declarative sentence under 200 characters**, present
tense, no hedging, no "the user said". The script rejects anything longer,
which is the point: an entry you cannot state in one sentence has not been
compacted yet.

## 9.6 Syntactic compaction — the script's job

```bash
M="$SKILL/scripts/memory.ts"
bun $M add --kind source --text "…" --tags vietnam,agriculture
bun $M compact            # dry run: shows what it would fold and drop
bun $M compact --apply    # writes
bun $M stats              # entry count, bytes, cap breaches
```

`compact` is deterministic and does only what can be checked mechanically:

- normalises whitespace, bullets, and stray punctuation;
- folds entries with ≥ 80% content-word overlap into one, keeping the longer
  wording and the earlier date, and unioning tags — across kinds, not just
  within one;
- enforces the caps: 12 entries per kind, 40 total, 8 KB file, 200 chars per
  entry, dropping the oldest over-cap entries;
- re-sorts newest first within each kind;
- reports pairs in the 55–80% band, which are too close to keep separate but
  too different for a script to merge. **Those are handed back to you** —
  collapse them by meaning and write the result with `replace`.

That last point is the division of labour: the script deduplicates *text*,
you deduplicate *meaning*. Run `compact --apply` at the end of stage 9, then
`stats`, and report the resulting entry count to the user.

Two checks in `add` exist to catch a skipped semantic pass:

- **A ledger id is rejected outright.** Text containing `[S014]`, `[E003]`,
  or similar exits 1. Memory carries no source and no audit, so an entry that
  needs a citation is evidence in the wrong place — non-negotiable 12.
- **Smells produce a warning, not a refusal.** A percentage, a bare year, or
  run-specific phrasing ("in this report", "the user said") usually means step
  2 or 3 was skipped. The entry is still stored, because judgement is yours:
  "Semantic Scholar 429s" contains a number and is a perfectly good `pitfall`.
  Read the warning, decide, and rewrite with `replace` if it was right.

## 9.7 Loading memory at the start of a run

Stage 1 opens with:

```bash
bun $M show
```

No memory yet is the normal first-run state and needs no comment. If entries
exist, apply them like this:

- **Surface them at the scope gate**, do not apply them silently. One line
  each: "From memory: you prefer Vietnamese output with English technical
  terms; I have set `--output-lang vi`." The user can then correct a stale
  preference before it costs a whole run.
- **`preference` and `terminology` apply automatically** — they are about
  presentation and cost nothing to get wrong twice.
- **`scope`, `source`, `method`, and `pitfall` are proposals.** They shape
  the plan you present, and the user approves that plan at gate 1 as usual.
- **The current request always wins.** If the user asks for English output
  today, memory saying Vietnamese is stale. Update it at stage 9 with
  `replace`, do not argue with it at stage 1.
- **A `pitfall` never prunes the search silently.** "Vendor whitepapers are
  noise" becomes a registered exclusion criterion with a reason, visible in
  `03-screening.md` and counted in the funnel — not an invisible filter.

## 9.8 Worked example

The user's answer at the end of a run about Vietnamese agriculture:

> Good report but write it in Vietnamese next time, technical terms in
> English is fine. Also Semantic Scholar kept erroring and OpenAlex barely
> had anything on Vietnamese journals, we got most of it from VJOL in the
> end. And that first plan was too broad, I only ever care about the Mekong
> Delta, not the whole country.

Four lessons, split and compacted:

```bash
bun $M add --kind preference  --text "Write reports in Vietnamese; leave technical terms in English" --tags lang
bun $M add --kind source      --text "OpenAlex indexes Vietnamese journals poorly; add VJOL as a primary route" --tags vietnam
bun $M add --kind pitfall     --text "Semantic Scholar 429s without SEMANTIC_SCHOLAR_API_KEY; skip it or set the key" --tags api
bun $M add --kind scope       --text "For Vietnam questions, scope to the Mekong Delta unless told otherwise" --tags vietnam
bun $M compact --apply
bun $M stats
```

Note what was dropped: "good report" (praise, not a lesson) and "we got most
of it from VJOL in the end" (folded into the `source` entry rather than kept
as a separate narrative). Note what was *not* stored: nothing about rice
yields, deltas, or any number from the report itself. And note the language:
the run was in Vietnamese, but every behavioural entry is English (step 7) —
only the `preference` *describes* the Vietnamese-output rule, it is not written
in Vietnamese. Had the user offered a term ("we say 'độ trễ' not 'latency'"),
that one `terminology` entry would have kept the Vietnamese verbatim.

## 9.9 Deliverable and gate

**Gate 5 — memory gate.** The last thing that happens in a run. Present:

- what you propose to remember, as the exact sentences you will store, one
  per line, before writing them;
- what you deliberately did not store, if the user offered a finding — say
  plainly that memory holds process knowledge only and that the finding is
  already cited in the report;
- after writing: the entry count from `stats`, and any pair `compact` handed
  back for a semantic merge.

If the answer was blank: "Nothing saved." and stop.

## 9.10 Checklist

- [ ] `bun $M show` was run at the start of stage 1
- [ ] Existing memory was surfaced at the scope gate, not applied silently
- [ ] The ask was made once, in `--interaction-lang` (default `--output-lang`), with category examples
- [ ] Blank answer → no file written, no empty file created, no retry
- [ ] Each lesson split, run-specifics stripped, generalised one step,
      actionable, merged against existing entries, classified, one sentence
- [ ] Behavioural kinds (`preference`, `scope`, `source`, `method`, `pitfall`)
      written in English; `terminology` and quoted user terms left in the
      user's language
- [ ] No entry contains a number, a finding, or anything needing `[S###]`
- [ ] `compact --apply` run, `stats` reported to the user
- [ ] Pairs in the 55–80% band merged by meaning with `replace`
