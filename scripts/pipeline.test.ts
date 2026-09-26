#!/usr/bin/env bun
/**
 * pipeline.test.ts — the run as a whole, plus the rules that only exist
 * between commands.
 *
 * ledger.test.ts holds each rule still one command at a time. Nothing held
 * the *shape of a run* still: that a real sequence of stages, written the way
 * SKILL.md tells an agent to write it, ends with `audit --report` exiting 0.
 * Every integration bug this pipeline can have lives in that gap — a filename
 * the audit expects and `state` spells differently, a stats block the report
 * carries and the ledger no longer matches, a gate nobody records.
 *
 *   bun test scripts/pipeline.test.ts
 *
 * Batch input throughout, which is also how a real run should look: the whole
 * nine stages here cost about a dozen process spawns.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const LEDGER = fileURLToPath(new URL("./ledger.ts", import.meta.url));
const SKILL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];

/**
 * Building a finished run costs dozens of process spawns, so the first test to
 * ask for one can sit well past bun's 5s default on a busy machine. The budget
 * is explicit here rather than left to how loaded the box is.
 */
const SLOW = 60_000;
const CACHE = mkdtempSync(`${tmpdir()}/drp-pipe-cache-`);
roots.push(CACHE);

type Run = { code: number; stdout: string; stderr: string };

function ledger(...args: string[]): Run {
  const p = Bun.spawnSync(["bun", LEDGER, ...args], {
    env: { ...process.env, DRP_CACHE_DIR: CACHE },
  });
  return {
    code: p.exitCode ?? -1,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

function newRun(mode = "standard", lang = "en"): string {
  const dir = mkdtempSync(`${tmpdir()}/drp-pipe-run-`);
  roots.push(dir);
  mkdirSync(`${dir}/sources`, { recursive: true });
  mkdirSync(`${dir}/raw`, { recursive: true });
  expect(ledger("init", "--dir", dir, "--topic", "does X work", "--mode", mode, "--lang", lang).code).toBe(0);
  return dir;
}

/** Three papers by three unrelated groups — enough for a `strong` consensus. */
const PAPERS = [1, 2, 3].map((n) => ({
  title: `Controlled study ${n} of the intervention`,
  authors: [`Author ${n}A`, `Author ${n}B`],
  year: 2023 + (n % 2),
  venue: `Journal ${n}`,
  doi: `10.5555/pipe.${n}`,
  url: `https://example.org/pipe-${n}`,
  abstract:
    `Study ${n} evaluates the intervention in a documented population and reports ` +
    "results in full. This abstract is comfortably past the two hundred character " +
    "floor that mark-read enforces, because a stub is not a source and the ledger " +
    "declines to pretend otherwise when a run later leans on it.",
}));

const FULL_TEXT = (id: string, n: number) =>
  `# Controlled study ${n}\n\n- id: ${id}\n\n## Results\n\n` +
  "Methods, population and limitations are given in full. ".repeat(12) +
  "Adoption reached 47% of surveyed teams in the second year.\n";

const jsonl = (dir: string, name: string, rows: unknown[]) => {
  const p = `${dir}/${name}`;
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
};

/**
 * Stages 1–7 of a standard run, batched. Returns the source ids the ledger
 * assigned, read back from disk rather than assumed.
 */
function runThroughReport(dir: string, opts: { gates?: boolean; lang?: string } = {}): string[] {
  const gates = opts.gates ?? true;

  // --- stage 1: criteria before searching, then the scope gate
  expect(ledger("add-criterion", "--dir", dir, "--id", "C1", "--direction", "include",
    "--text", "reports a measured outcome", "--stage", "abstract").code).toBe(0);
  writeFileSync(`${dir}/00-brief.md`, "# Brief\n");
  writeFileSync(`${dir}/01-plan.md`, "# Plan\n");
  if (gates) expect(ledger("gate", "--dir", dir, "--pass", "scope", "--note", "approved").code).toBe(0);

  // --- stage 2: search log, sources, the read that makes them citable
  expect(ledger("log-query", "--dir", dir, "--q", "intervention outcome study",
    "--source", "openalex", "--hits", "20", "--kept", "3").code).toBe(0);
  writeFileSync(`${dir}/raw/hits.json`, JSON.stringify(PAPERS), { flag: "w" });
  expect(ledger("add-source", "--dir", dir, "--file", `${dir}/raw/hits.json`, "--from", "openalex").code).toBe(0);

  const ids: string[] = JSON.parse(readFileSync(`${dir}/ledger.json`, "utf8")).sources.map((s: any) => s.id);
  expect(ids.length).toBe(3);
  ids.forEach((id, i) => {
    writeFileSync(`${dir}/sources/${id}.md`, FULL_TEXT(id, i + 1));
    expect(ledger("mark-read", "--dir", dir, "--source", id, "--scope", "fulltext", "--no-cache").code).toBe(0);
  });
  writeFileSync(`${dir}/02-search-log.md`, "# Search log\n");
  if (gates) expect(ledger("gate", "--dir", dir, "--pass", "coverage").code).toBe(0);

  // --- stage 3: screening, evidence, extraction — one spawn each
  expect(ledger("screen", "--dir", dir, "--batch", jsonl(dir, "screen.jsonl",
    ids.map((id) => ({ source: id, verdict: "include", stage: "fulltext", criteria: { C1: "pass" }, quote: "reports a measured outcome" })))).code).toBe(0);

  expect(ledger("add-evidence", "--dir", dir, "--batch", jsonl(dir, "evidence.jsonl",
    ids.map((id) => ({
      source: id, question: "SQ1", score: 8,
      summary: "Adoption reached 47% of surveyed teams.",
      quote: "Adoption reached 47% of surveyed teams in the second year.",
      locator: "§Results", scope_note: "second year, surveyed teams only",
    })))).code).toBe(0);

  expect(ledger("extract", "--dir", dir, "--batch", jsonl(dir, "extract.jsonl",
    ids.map((id) => ({
      source: id, col: "adoption", value: "47%",
      quote: "Adoption reached 47% of surveyed teams in the second year.", locator: "§Results",
    })))).code).toBe(0);
  writeFileSync(`${dir}/03-screening.md`, "# Screening\n");
  if (gates) expect(ledger("gate", "--dir", dir, "--pass", "sufficiency").code).toBe(0);

  // --- stage 4: claims. Three independent sources, so `strong` is allowed.
  const evIds: string[] = JSON.parse(readFileSync(`${dir}/ledger.json`, "utf8")).evidence.map((e: any) => e.id);
  expect(ledger("claim", "--dir", dir, "--id", "CL001",
    "--text", "The intervention reaches roughly half of surveyed teams by year two",
    "--evidence", evIds.join(","), "--consensus", "strong").code).toBe(0);
  writeFileSync(`${dir}/04-synthesis.md`, "# Synthesis\n");

  // --- stage 5: verification
  expect(ledger("verify", "--dir", dir, "--batch", jsonl(dir, "verify.jsonl", [{
    claim: "CL001", question: "Do all three sources measure the same population?",
    answer: "Yes — surveyed teams, second year, in each study.",
    status: "supported", evidence: evIds,
  }])).code).toBe(0);
  writeFileSync(`${dir}/05-verification.md`, "# Verification\n");

  // --- stage 6: the graph, whose ids the audit checks like any citation
  writeFileSync(`${dir}/graph.json`, JSON.stringify({
    metadata: { node_count: 2, edge_count: 1 },
    nodes: [
      { id: "intervention", label: "The intervention", ledger_ids: [ids[0], ids[1]] },
      { id: "adoption", label: "Adoption", ledger_ids: [ids[2]] },
    ],
    edges: [{ source: "intervention", target: "adoption", label: "drives", ledger_ids: [ids[0]] }],
  }, null, 2));
  writeFileSync(`${dir}/06-knowledge-graph.md`, "# Graph\n");

  // --- stage 7: the report, with the counts block taken from the tool
  const statsMd = ledger("stats", "--dir", dir, "--md");
  expect(statsMd.code).toBe(0);
  const asOf = opts.lang === "ja"
    ? `<!-- drp:as-of ${new Date().toISOString().slice(0, 10)} -->\n\n証拠の収集日。\n`
    : `Evidence current as of ${new Date().toISOString().slice(0, 10)}.\n`;
  writeFileSync(`${dir}/REPORT.md`, [
    `# Does X work`, ``, asOf, ``,
    `## Findings`, ``,
    `Adoption reached 47% of surveyed teams in the second year ${ids.map((i) => `[${i}]`).join(" ")}.`, ``,
    `## Counts`, ``, statsMd.stdout, ``,
    opts.lang === "ja" ? `<!-- drp:references -->` : `## References`, ``,
    ...ids.map((i) => `[${i}] a study.`),
  ].join("\n"));
  writeFileSync(`${dir}/gaps.md`, "# Gaps\n");
  writeFileSync(`${dir}/08-audit.md`, "# Audit\n");
  return ids;
}

/**
 * A finished run, built once per (mode, gates, language) and copied per test.
 *
 * Nine stages cost about a dozen process spawns, and a spawn is the whole cost
 * of a CLI test — so the eight tests below used to spend most of their time
 * rebuilding identical fixtures. `cpSync` of a finished run is milliseconds,
 * and each test still gets a directory it can mutate freely.
 */
const templates = new Map<string, string>();

function finishedRun(opts: { mode?: string; gates?: boolean; lang?: string } = {}): string {
  const mode = opts.mode ?? "standard";
  const lang = opts.lang ?? "en";
  const gates = opts.gates ?? true;
  const key = `${mode}|${gates}|${lang}`;

  if (!templates.has(key)) {
    const built = newRun(mode, lang);
    runThroughReport(built, { gates, lang });
    templates.set(key, built);
  }
  const dir = mkdtempSync(`${tmpdir()}/drp-pipe-copy-`);
  roots.push(dir);
  cpSync(templates.get(key)!, dir, { recursive: true });
  return dir;
}

/** The ids a finished run assigned, read back from its ledger. */
const idsOf = (dir: string): string[] =>
  JSON.parse(readFileSync(`${dir}/ledger.json`, "utf8")).sources.map((s: any) => s.id);

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------ end to end

describe("a whole run", () => {
  test("nine stages, written as SKILL.md describes them, audit clean", () => {
    const dir = finishedRun();
    const ids = idsOf(dir);

    const audit = ledger("audit", "--dir", dir, "--report");
    expect(audit.stdout).toContain("0 error(s)");
    expect(audit.code).toBe(0);

    // …and the run knows where it is, which is what resuming depends on.
    const state = JSON.parse(ledger("state", "--dir", dir, "--json").stdout);
    expect(state.blocking.join(" ")).not.toContain("REPORT.md");
    expect(state.counts.included).toBe(3);
    expect(state.gates.filter((g: any) => g.passed).map((g: any) => g.gate))
      .toEqual(["scope", "coverage", "sufficiency"]);

    // The bibliography and matrix render from the same ledger.
    const bib = ledger("bib", "--dir", dir).stdout;
    for (const id of ids) expect(bib).toContain(`[${id}]`);
    expect(ledger("matrix", "--dir", dir).stdout).toContain("adoption");
  }, SLOW);

  test("a hand-edited count in the delivered report fails the finished run", () => {
    const dir = finishedRun();
    expect(ledger("audit", "--dir", dir, "--report").code).toBe(0);

    const report = readFileSync(`${dir}/REPORT.md`, "utf8");
    writeFileSync(`${dir}/REPORT.md`, report.replace('"included":3', '"included":30'));
    const audit = ledger("audit", "--dir", dir, "--report");
    expect(audit.code).toBe(1);
    expect(audit.stdout).toContain("stats-block-stale");
  }, SLOW);

  test("deleting a cached source after delivery breaks the audit", () => {
    const dir = finishedRun();
    rmSync(`${dir}/sources/${idsOf(dir)[0]}.md`);
    const audit = ledger("audit", "--dir", dir, "--report");
    expect(audit.code).toBe(1);
    expect(audit.stdout).toContain("cache-missing");
  }, SLOW);
});

// ---------------------------------------------------------------- gates

describe("gates are checked, not just recorded", () => {
  test("evidence with no scope gate is a finding", () => {
    const dir = finishedRun({ gates: false });
    const audit = ledger("audit", "--dir", dir);
    expect(audit.stdout).toContain("gate-skipped");
    expect(audit.stdout).toContain("scope gate was never recorded");
    expect(audit.code).toBe(0); // a warning in standard mode
  }, SLOW);

  test("a report with no coverage or sufficiency gate is a finding", () => {
    const dir = finishedRun({ gates: false });
    const audit = ledger("audit", "--dir", dir, "--report");
    expect(audit.stdout).toContain("coverage gate was never recorded");
    expect(audit.stdout).toContain("sufficiency gate was never recorded");
  }, SLOW);

  test("in systematic mode a skipped gate blocks delivery", () => {
    const dir = finishedRun({ mode: "systematic", gates: false });
    const audit = ledger("audit", "--dir", dir, "--report");
    expect(audit.code).toBe(1);
    expect(audit.stdout).toContain("Errors — must be fixed before delivery");
    expect(audit.stdout).toContain("gate-skipped");
  }, SLOW);

  test("recording the gates clears the finding", () => {
    const dir = finishedRun({ mode: "systematic" });
    const audit = ledger("audit", "--dir", dir, "--report");
    expect(audit.stdout).not.toContain("gate-skipped");
    expect(audit.code).toBe(0);
  }, SLOW);
});

// ------------------------------------------------------- output language

describe("output language is not an en/vi choice", () => {
  test("init accepts any ISO 639 code", () => {
    for (const lang of ["ja", "pt-BR", "de"]) {
      const dir = mkdtempSync(`${tmpdir()}/drp-pipe-lang-`);
      roots.push(dir);
      expect(ledger("init", "--dir", dir, "--topic", "t", "--lang", lang).code).toBe(0);
      expect(JSON.parse(readFileSync(`${dir}/ledger.json`, "utf8")).lang).toBe(lang);
    }
  });

  test("a nonsense language is refused", () => {
    const dir = mkdtempSync(`${tmpdir()}/drp-pipe-lang-`);
    roots.push(dir);
    const r = ledger("init", "--dir", dir, "--topic", "t", "--lang", "Vietnamese please");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ISO 639");
  });

  test("an invented mode is refused", () => {
    const dir = mkdtempSync(`${tmpdir()}/drp-pipe-mode-`);
    roots.push(dir);
    const r = ledger("init", "--dir", dir, "--topic", "t", "--mode", "exhaustive");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("systematic");
  });

  test("a Japanese report passes on the drp:as-of and drp:references markers", () => {
    const dir = finishedRun({ lang: "ja" });
    const audit = ledger("audit", "--dir", dir, "--report");
    expect(audit.stdout).not.toContain("no-currency-line");
    expect(audit.code).toBe(0);
  }, SLOW);

  test("no currency line at all is still an error", () => {
    const dir = finishedRun();
    const report = readFileSync(`${dir}/REPORT.md`, "utf8");
    writeFileSync(`${dir}/REPORT.md`, report.replace(/Evidence current as of[^\n]*/, ""));
    const audit = ledger("audit", "--dir", dir, "--report");
    expect(audit.code).toBe(1);
    expect(audit.stdout).toContain("no-currency-line");
  }, SLOW);
});

// ------------------------------------------------------------- contract

describe("the generated contract", () => {
  test("prints between its markers and carries the live thresholds", () => {
    const r = ledger("contract", "--md");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("<!-- drp:contract v1 -->");
    expect(r.stdout).toContain("<!-- /drp:contract -->");
    expect(r.stdout).toContain("score ≥ 7");           // CITE_THRESHOLD
    expect(r.stdout).toContain("≥ 200 chars");          // MIN_CACHE_CHARS
    expect(r.stdout).toContain("REPORT.md");            // RUN_FILES
    expect(r.stdout).toContain("`quick`, `standard`, `systematic`, `interactive`");
  });

  test("references/ledger.md embeds the current contract", () => {
    // The whole point of generating it: the doc cannot describe a threshold
    // the code stopped enforcing. If this fails, run
    // `bun scripts/ledger.ts contract --md` and replace the block.
    const r = ledger("contract", "--check", `${SKILL_ROOT}/references/ledger.md`);
    expect(r.stdout).toContain("in sync");
    expect(r.code).toBe(0);
  });

  test("--check reports a stale copy instead of silently passing", () => {
    const dir = mkdtempSync(`${tmpdir()}/drp-pipe-contract-`);
    roots.push(dir);
    const block = ledger("contract", "--md").stdout;
    writeFileSync(`${dir}/doc.md`, block.replace("score ≥ 7", "score ≥ 4"));
    const r = ledger("contract", "--check", `${dir}/doc.md`);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("STALE");
  });
});
