# Harness map — resolve this once, at stage 0

This skill names three capabilities it cannot provide itself: a web search, a
page fetch, and a sub-agent to fan out with. Every other file writes them as
`<search>`, `<fetch>` and `<subagent>`, because their real names differ per
harness and a file that hard-codes one harness's names is wrong everywhere
else. Two lines of setup at stage 0 and the rest of the pipeline reads the
same on all of them.

## 1. `$SKILL` — where this skill lives

Every command in every reference file is written `bun $SKILL/scripts/…`. Set
it once, from the directory holding the `SKILL.md` you are reading:

```powershell
$SKILL = ".kiro/skills/deep-research-pipeline"       # Kiro
# $SKILL = ".claude/skills/deep-research-pipeline"   # Claude Code (project)
# $SKILL = "$HOME/.claude/skills/deep-research-pipeline"  # Claude Code (user)
```

```bash
SKILL=".kiro/skills/deep-research-pipeline"          # adjust to where it is installed
```

Forward slashes work on Windows, macOS and Linux. If you do not know where the
skill is, find it rather than guess: `SKILL.md` sits next to `scripts/` and
`references/`. Nothing else in the pipeline needs the path — the scripts
resolve `memory.md` and the shared cache relative to themselves.

## 2. The three tools

| Written as | What it must do | Claude Code | Kiro | Codex / plain CLI |
|---|---|---|---|---|
| `<search>` | Web search, returns candidate URLs | `WebSearch` | `web_search` | the harness's search tool, or none |
| `<fetch>` | Fetch one URL, return its text | `WebFetch` | `web_fetch` | the harness's fetch tool, or `curl` |
| `<subagent>` | Run one sub-query in a fresh context and return a file | `Task` (general-purpose agent) | `subagent`, role `kiro_default` | the harness's agent tool, or none |

Name the mapping out loud at the scope gate — the user should know which of
these you actually have before the budget goes.

## 3. When a capability is missing

Nothing here is fatal on its own. Say which one is missing, at the scope gate,
and adjust the plan rather than the standards.

**No `<search>` or `<fetch>`.** The scholarly leg still works in full:
`scholar.ts search / cites / fetch` reaches OpenAlex, Semantic Scholar,
Crossref and Europe PMC over plain HTTPS, with no harness tool involved. What
you lose is the web leg — news, vendor documentation, incident write-ups,
anything younger than the indexes. Say so, and treat the gap as a documented
limit of the run, not a licence to fill it from memory (non-negotiable 3).

**No `<subagent>`.** Run the sub-queries in sequence in your own context
instead of fanning out. The executor contract in `executor-contract.md` still
describes what each sub-query must return; you are simply the executor. Expect
a longer run and more context pressure — `ledger.ts state` is how you recover
after a compaction.

**No `pdftotext`.** `scholar.ts doctor` reports it at stage 0, and
`doctor --strict` exits 1 on it — run that before promising a `systematic` run,
where full text is mandatory. PDF-only sources cannot be converted, so `fetch`
exits 3 on them; either read the PDF with `<fetch>` and write the text to
`$R/sources/S###.md` yourself, or screen the source out as `unobtainable` and
disclose the access bias — `audit` warns when that reaches 15% of what was
screened.

## 4. Frontmatter and invocation

`SKILL.md` carries `name` and `description`, which every harness reads. How a
skill is invoked, whether it takes an argument hint, and what a read-write
classification means are harness questions, answered by the harness's own
configuration — not by this file. The pipeline itself needs nothing beyond
`bun` on `PATH` and a writable working directory.
