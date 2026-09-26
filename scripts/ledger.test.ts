#!/usr/bin/env bun
/**
 * ledger.test.ts — the rules the pipeline claims to enforce, tested through
 * the CLI rather than through internal functions.
 *
 * Why the CLI: the contract the skill relies on is not "this function returns
 * an array", it is "this command exits 1 when the report cites a source that
 * never passed screening". Exit codes and stderr are the interface SKILL.md
 * points at, so they are what these tests hold still.
 *
 *   bun test scripts/ledger.test.ts
 *
 * Every test runs in its own temp directory and its own cache directory, so
 * nothing here can touch a real research run or the shared source cache.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const LEDGER = fileURLToPath(new URL("./ledger.ts", import.meta.url));
const SCHOLAR = fileURLToPath(new URL("./scholar.ts", import.meta.url));
const roots: string[] = [];

let R = "";
const CACHE = mkdtempSync(`${tmpdir()}/drp-test-cache-`);
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

/** ledger.ts with extra environment — for DRP_RUN_DIR, which is the point of the flag. */
function ledgerIn(env: Record<string, string>, ...args: string[]): Run {
  const p = Bun.spawnSync(["bun", LEDGER, ...args], {
    env: { ...process.env, DRP_CACHE_DIR: CACHE, ...env },
  });
  return {
    code: p.exitCode ?? -1,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

/**
 * scholar.ts, used here only for `doctor --offline`: the rest of that script
 * talks to the network, which these tests never do.
 */
function scholar(env: Record<string, string>, ...args: string[]): Run {
  const p = Bun.spawnSync(["bun", SCHOLAR, ...args], {
    env: { ...process.env, DRP_CACHE_DIR: CACHE, ...env },
  });
  return {
    code: p.exitCode ?? -1,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

/** A source with an abstract long enough for --from-abstract to accept. */
const source = (n: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  title: `Test paper ${n}`,
  authors: [`Author ${n}`],
  year: 2024,
  doi: `10.5555/test.${n}`,
  url: `https://example.org/paper-${n}`,
  abstract:
    `Paper ${n} reports on a controlled study of a documented intervention. ` +
    "The abstract is deliberately long enough to clear the two hundred character " +
    "floor that mark-read enforces, because a stub is not a source and the " +
    "pipeline refuses to treat one as if it were. Adoption reached 47% of teams.",
  ...extra,
});

function init(mode = "standard"): void {
  R = mkdtempSync(`${tmpdir()}/drp-test-run-`);
  roots.push(R);
  mkdirSync(`${R}/sources`, { recursive: true });
  const r = ledger("init", "--dir", R, "--topic", "test topic", "--mode", mode, "--lang", "en");
  expect(r.code).toBe(0);
}

/**
 * A source that is read and screened in. Returns the id the ledger assigned —
 * read back from disk rather than assumed, because ids are the ledger's to
 * hand out.
 *
 * `fulltext` writes a body file and marks the read as full text; otherwise the
 * source is abstract-only, which is the case most of the scope rules turn on.
 * `cache` lets the read feed the shared cross-run cache; by default it does
 * not, so one test cannot seed another.
 */
function citableSource(n: number, opts: { fulltext?: boolean; cache?: boolean } = {}): string {
  expect(ledger("add-source", "--dir", R, "--json", source(n)).code).toBe(0);
  const sources = JSON.parse(readFileSync(`${R}/ledger.json`, "utf8")).sources;
  const id: string = sources[sources.length - 1].id;

  if (opts.fulltext) {
    writeFileSync(
      `${R}/sources/${id}.md`,
      `# Test paper ${n}\n\n- id: ${id}\n\n## Full text\n\n` +
      "Methods and results in full. ".repeat(20) +
      "Adoption reached 47% of teams in the surveyed population.\n",
    );
    const args = ["mark-read", "--dir", R, "--source", id, "--scope", "fulltext"];
    if (!opts.cache) args.push("--no-cache");
    expect(ledger(...args).code).toBe(0);
  } else {
    expect(ledger("mark-read", "--dir", R, "--source", id, "--from-abstract").code).toBe(0);
  }
  expect(ledger("screen", "--dir", R, "--source", id, "--verdict", "include").code).toBe(0);
  return id;
}

beforeEach(() => init());

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

// --------------------------------------------------------------- refusals

describe("refusals (exit 2)", () => {
  test("a number in the summary that the quote does not contain is refused, not recorded", () => {
    const id = citableSource(1);
    const r = ledger(
      "add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "Adoption reached 47% of teams.", "--quote", "adoption grew among teams",
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("47%");
    // and nothing was written
    expect(ledger("stats", "--dir", R, "--json").stdout).toContain('"total": 0');
  });

  test("a converted unit counts as absent: 0.87 in the quote does not license 87%", () => {
    const id = citableSource(2);
    const r = ledger(
      "add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "Agreement was 87%.", "--quote", "the agreement coefficient was 0.87 across raters",
    );
    expect(r.code).toBe(2);
  });

  test("a number present in the quote is accepted", () => {
    const id = citableSource(3);
    const r = ledger(
      "add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "Adoption reached 47% of teams.",
      "--quote", "Adoption reached 47% of teams surveyed.",
      "--locator", "abstract", "--scope-note", "one survey, 2024",
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("E001");
  });

  test("citation ids and section numbers are not treated as figures", () => {
    const id = citableSource(4);
    const r = ledger(
      "add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "7",
      "--summary", "The method is described in section 3.2 [S004].",
      "--quote", "we describe the method used throughout the study",
    );
    expect(r.code).toBe(0);
  });

  test("evidence below the keep threshold is refused", () => {
    const id = citableSource(5);
    const r = ledger(
      "add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "4",
      "--summary", "Tangentially related.", "--quote", "a passing mention",
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("keep threshold");
  });

  test("mark-read refuses a stub cache file", () => {
    expect(ledger("add-source", "--dir", R, "--json", source(6)).code).toBe(0);
    writeFileSync(`${R}/sources/S001.md`, "# too short\n");
    const r = ledger("mark-read", "--dir", R, "--source", "S001", "--no-cache");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/stub, not a source/);
  });

  test("re-registering a pre-registered criterion is refused", () => {
    expect(ledger("add-criterion", "--dir", R, "--id", "C1", "--direction", "include", "--text", "peer reviewed").code).toBe(0);
    const r = ledger("add-criterion", "--dir", R, "--id", "C1", "--direction", "include", "--text", "something else");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already exists");
  });
});

// ----------------------------------------------------------- audit: ledger

describe("audit — ledger integrity", () => {
  test("a clean ledger exits 0", () => {
    const id = citableSource(1);
    ledger("add-criterion", "--dir", R, "--id", "C1", "--direction", "include", "--text", "peer reviewed");
    ledger("log-query", "--dir", R, "--q", "test query", "--source", "web", "--hits", "3", "--kept", "1");
    ledger("add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "The intervention was documented.", "--quote", "a controlled study of a documented intervention",
      "--locator", "abstract", "--scope-note", "one study");
    const r = ledger("audit", "--dir", R);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("0 error(s)");
  });

  test("an included source that was never read is an error", () => {
    expect(ledger("add-source", "--dir", R, "--json", source(1)).code).toBe(0);
    expect(ledger("screen", "--dir", R, "--source", "S001", "--verdict", "include").code).toBe(0);
    const r = ledger("audit", "--dir", R);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("included-but-unread");
  });

  test("a deleted cache file makes quotes uncheckable and is an error", () => {
    const id = citableSource(1);
    rmSync(`${R}/sources/${id}.md`);
    const r = ledger("audit", "--dir", R);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("cache-missing");
  });

  test("one source cannot carry a strong consensus", () => {
    const id = citableSource(1);
    ledger("add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "The intervention was documented.", "--quote", "a controlled study of a documented intervention");
    expect(ledger("claim", "--dir", R, "--text", "The intervention works.", "--evidence", "E001", "--consensus", "strong").code).toBe(0);
    const r = ledger("audit", "--dir", R);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("overstated-consensus");
  });

  test("an unsupported verification result blocks delivery", () => {
    const id = citableSource(1);
    ledger("add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "The intervention was documented.", "--quote", "a controlled study of a documented intervention");
    ledger("claim", "--dir", R, "--text", "The intervention works.", "--evidence", "E001", "--consensus", "thin");
    expect(ledger("verify", "--dir", R, "--claim", "CL001", "--question", "Does the source say this?",
      "--answer", "No, it says something narrower.", "--status", "unsupported").code).toBe(0);
    const r = ledger("audit", "--dir", R);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("claim-failed-verification");
  });

  test("a figure taken from an abstract cannot back a claim outside quick mode", () => {
    const id = citableSource(1);                       // abstract-only
    ledger("add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "Adoption reached 47% of teams.", "--quote", "Adoption reached 47% of teams.");
    ledger("claim", "--dir", R, "--text", "Adoption is at 47%.", "--evidence", "E001", "--consensus", "thin");
    const r = ledger("audit", "--dir", R);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("figure-from-abstract");
  });

  test("the same figure read in full text is fine", () => {
    const id = citableSource(1, { fulltext: true });
    ledger("add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "Adoption reached 47% of teams.", "--quote", "Adoption reached 47% of teams in the surveyed population.",
      "--locator", "§3", "--scope-note", "one survey");
    ledger("claim", "--dir", R, "--text", "Adoption is at 47%.", "--evidence", "E001", "--consensus", "thin");
    const r = ledger("audit", "--dir", R);
    expect(r.stdout).not.toContain("figure-from-abstract");
    expect(r.code).toBe(0);
  });
});

// ----------------------------------------------------------- audit: report

describe("audit --report — the deliverable", () => {
  const REPORT_HEAD = "# Report\n\nEvidence current as of 2026-09-02.\n\n";

  function reportRun(body: string, mode = "standard"): Run {
    init(mode);
    const id = citableSource(1, { fulltext: true });
    ledger("add-criterion", "--dir", R, "--id", "C1", "--direction", "include", "--text", "peer reviewed");
    ledger("log-query", "--dir", R, "--q", "test query", "--source", "web", "--hits", "3", "--kept", "1");
    ledger("add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "Adoption reached 47% of teams.", "--quote", "Adoption reached 47% of teams in the surveyed population.",
      "--locator", "§3", "--scope-note", "one survey");
    writeFileSync(`${R}/REPORT.md`, REPORT_HEAD + body);
    return ledger("audit", "--dir", R, "--report");
  }

  test("a citation the ledger does not know is a fabricated citation", () => {
    const r = reportRun("Some finding [S099].\n");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("citation-unknown-id");
  });

  test("a figure in a paragraph that cites nothing is an error", () => {
    const r = reportRun("Adoption reached 47% of teams.\n");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("figure-without-citation");
  });

  test("a missing currency line is an error", () => {
    init();
    const id = citableSource(1, { fulltext: true });
    writeFileSync(`${R}/REPORT.md`, `# Report\n\nA finding [${id}].\n`);
    const r = ledger("audit", "--dir", R, "--report");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("no-currency-line");
  });

  test("a cited, dated, full-text-backed figure passes", () => {
    const r = reportRun("Adoption reached 47% of teams [S001].\n");
    expect(r.stdout).toContain("0 error(s)");
    expect(r.code).toBe(0);
  });

  test("a figure resting only on an abstract-only source is an error in standard mode", () => {
    init("standard");
    const id = citableSource(1);                       // abstract-only
    writeFileSync(`${R}/REPORT.md`, `${REPORT_HEAD}Adoption reached 47% of teams [${id}].\n`);
    const r = ledger("audit", "--dir", R, "--report");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("report-figure-from-abstract");
  });

  test("the same report is only a warning in quick mode, which works from abstracts by design", () => {
    init("quick");
    const id = citableSource(1);
    writeFileSync(`${R}/REPORT.md`, `${REPORT_HEAD}Adoption reached 47% of teams [${id}].\n`);
    const r = ledger("audit", "--dir", R, "--report");
    expect(r.stdout).toContain("report-figure-from-abstract");
    expect(r.code).toBe(0);
  });

  test("ids in the reference list are definitions, not citations", () => {
    init();
    const id = citableSource(1, { fulltext: true });
    writeFileSync(
      `${R}/REPORT.md`,
      `${REPORT_HEAD}A qualitative finding [${id}].\n\n## References\n\n[S099] Something not in the ledger.\n`,
    );
    const r = ledger("audit", "--dir", R, "--report");
    expect(r.stdout).not.toContain("citation-unknown-id");
  });
});

// ----------------------------------------------------- concurrency and state

describe("concurrent writers", () => {
  test("eight parallel add-source calls all land", async () => {
    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", LEDGER, "add-source", "--dir", R, "--json", source(100 + i)], {
        env: { ...process.env, DRP_CACHE_DIR: CACHE },
        stdout: "ignore", stderr: "ignore",
      }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes.every((c) => c === 0)).toBe(true);
    const stats = JSON.parse(ledger("stats", "--dir", R, "--json").stdout);
    expect(stats.funnel.identified).toBe(8);
    expect(await Bun.file(`${R}/ledger.lock`).exists()).toBe(false);
  });

  /**
   * Sixteen writers, because eight was not enough contention to catch the bug
   * this guards: on NTFS a lock file being deleted reports EPERM rather than
   * EEXIST, and the retry loop used to treat that as fatal. One writer in
   * roughly one of six fan-outs died and its record vanished.
   */
  test("sixteen parallel writers all land — a lock being deleted is contention, not a fault", async () => {
    const procs = Array.from({ length: 16 }, (_, i) =>
      Bun.spawn(["bun", LEDGER, "add-source", "--dir", R, "--json", source(200 + i)], {
        env: { ...process.env, DRP_CACHE_DIR: CACHE },
        stdout: "ignore", stderr: "pipe",
      }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    expect(errs.join("\n")).not.toContain("EPERM");
    expect(codes.every((c) => c === 0)).toBe(true);
    expect(JSON.parse(ledger("stats", "--dir", R, "--json").stdout).funnel.identified).toBe(16);
    expect(await Bun.file(`${R}/ledger.lock`).exists()).toBe(false);
  });
});

describe("run state", () => {
  test("state names the current stage and what blocks it", () => {
    const r = ledger("state", "--dir", R, "--json");
    expect(r.code).toBe(0);
    const st = JSON.parse(r.stdout);
    expect(st.stage).toBe(1);
    expect(st.blocking.join(" ")).toContain("00-brief.md");
    expect(st.gates.find((g: any) => g.gate === "scope").passed).toBe(false);
  });

  test("a stage with its files in place still waits for its gate", () => {
    writeFileSync(`${R}/00-brief.md`, "brief");
    writeFileSync(`${R}/01-plan.md`, "plan");
    ledger("add-criterion", "--dir", R, "--id", "C1", "--direction", "include", "--text", "peer reviewed");
    expect(JSON.parse(ledger("state", "--dir", R, "--json").stdout).stage).toBe(1);
    expect(ledger("gate", "--dir", R, "--pass", "scope", "--note", "user approved").code).toBe(0);
    expect(JSON.parse(ledger("state", "--dir", R, "--json").stdout).stage).toBe(2);
  });

  test("an unknown gate name is rejected", () => {
    expect(ledger("gate", "--dir", R, "--pass", "vibes").code).toBe(1);
  });

  test("a later stage whose files exist does not read as done while an earlier one is open", () => {
    writeFileSync(`${R}/REPORT.md`, "# Report\n");
    writeFileSync(`${R}/gaps.md`, "none\n");
    const st = JSON.parse(ledger("state", "--dir", R, "--json").stdout);
    expect(st.stage).toBe(1);
    const seven = st.stages.find((s: any) => s.n === 7);
    expect(seven.status).toBe("todo");
    expect(seven.missing.join(" ")).toContain("earlier stage is open");
  });
});

describe("shared cache", () => {
  test("a full-text read is cached and reused by the next run", () => {
    citableSource(1, { fulltext: true, cache: true });
    expect(ledger("cache", "--list").stdout).toContain("doi-");

    init();                                            // a second, independent run
    expect(ledger("add-source", "--dir", R, "--json", source(1)).code).toBe(0);
    const r = ledger("mark-read", "--dir", R, "--source", "S001");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("reused from the shared cache");
    expect(r.stdout).toContain("fulltext");
  });

  test("--no-cache keeps a run off the shared cache", () => {
    init();
    expect(ledger("add-source", "--dir", R, "--json", source(77)).code).toBe(0);
    const before = ledger("cache", "--list").stdout;
    writeFileSync(`${R}/sources/S001.md`, `# Paper 77\n\n${"Full text body. ".repeat(30)}`);
    expect(ledger("mark-read", "--dir", R, "--source", "S001", "--no-cache").code).toBe(0);
    expect(ledger("cache", "--list").stdout).toBe(before);
  });
});

// ------------------------------------------------------------- strict flags

describe("unknown flags", () => {
  test("a misspelt flag is rejected with a suggestion and writes nothing", () => {
    const r = ledger("add-criterion", "--dir", R, "--id", "C1", "--direction", "include", "--tex", "peer reviewed");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('did you mean "text"');
    expect(JSON.parse(ledger("stats", "--dir", R, "--json").stdout).criteria).toBe(0);
  });

  test("a misspelt optional flag is rejected too — that is the case that used to be silent", () => {
    const id = citableSource(1, { fulltext: true });
    const r = ledger(
      "add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "Adoption grew.", "--quote", "Adoption grew among teams.", "--locater", "§3",
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('did you mean "locator"');
    expect(ledger("stats", "--dir", R, "--json").stdout).toContain('"total": 0');
  });

  test("--batch on a command that does not take it is rejected", () => {
    const r = ledger("add-source", "--dir", R, "--batch", "x.jsonl");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("batch");
  });
});

// ----------------------------------------------------------- DRP_RUN_DIR

describe("DRP_RUN_DIR", () => {
  test("--dir may come from the environment", () => {
    const r = ledgerIn({ DRP_RUN_DIR: R }, "state", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).stage).toBe(1);
  });

  test("an explicit --dir wins over the environment", () => {
    const r = ledgerIn({ DRP_RUN_DIR: `${R}-does-not-exist` }, "state", "--dir", R, "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).topic).toBe("test topic");
  });
});

// ------------------------------------------------------------------ batch

describe("--batch", () => {
  /** Three sources, read and unscreened, so a batch has something to act on. */
  function threeSources(): string[] {
    const ids: string[] = [];
    for (let n = 1; n <= 3; n++) {
      expect(ledger("add-source", "--dir", R, "--json", source(n)).code).toBe(0);
      const ss = JSON.parse(readFileSync(`${R}/ledger.json`, "utf8")).sources;
      ids.push(ss[ss.length - 1].id);
    }
    expect(ledger("mark-read", "--dir", R, "--all-from-abstract").code).toBe(0);
    return ids;
  }

  function batchFile(name: string, lines: unknown[]): string {
    const p = `${R}/${name}`;
    writeFileSync(p, lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
    return p;
  }

  test("many records land in one call, one lock, one write", () => {
    const ids = threeSources();
    const f = batchFile("screen.jsonl", ids.map((id) => ({ source: id, verdict: "include" })));
    const r = ledger("screen", "--dir", R, "--batch", f);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("3 applied, 0 refused, 0 failed");
    expect(JSON.parse(ledger("stats", "--dir", R, "--json").stdout).funnel.screened).toBe(3);
  });

  test("ids keep incrementing across a batch", () => {
    const ids = threeSources();
    ledger("screen", "--dir", R, "--batch", batchFile("s.jsonl", ids.map((id) => ({ source: id, verdict: "include" }))));
    const f = batchFile("ev.jsonl", ids.map((id) => ({
      source: id, question: "SQ1", score: 8,
      summary: "Adoption grew among teams", quote: "Adoption reached 47% of teams",
      locator: "abstract", scope_note: "one survey",
    })));
    expect(ledger("add-evidence", "--dir", R, "--batch", f).code).toBe(0);
    const l = JSON.parse(readFileSync(`${R}/ledger.json`, "utf8"));
    expect(l.evidence.map((e: any) => e.id)).toEqual(["E001", "E002", "E003"]);
  });

  test("a bad line is named with its line number and is not written; the good lines are", () => {
    const ids = threeSources();
    const f = batchFile("mixed.jsonl", [
      { source: ids[0], verdict: "include" },
      { source: "S999", verdict: "include" },
      { source: ids[1], verdict: "exclude", reason: "off-topic" },
    ]);
    const r = ledger("screen", "--dir", R, "--batch", f);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("2 applied, 0 refused, 1 failed");
    expect(r.stderr).toContain("line 2 ERROR");
    expect(JSON.parse(ledger("stats", "--dir", R, "--json").stdout).funnel.screened).toBe(2);
  });

  test("a refused line makes the whole call exit 2, and the refusal is per line", () => {
    const ids = threeSources();
    ledger("screen", "--dir", R, "--batch", batchFile("s.jsonl", ids.map((id) => ({ source: id, verdict: "include" }))));
    const f = batchFile("ev.jsonl", [
      { source: ids[0], question: "SQ1", score: 8, summary: "Adoption grew", quote: "Adoption reached 47% of teams", locator: "abstract" },
      { source: ids[1], question: "SQ1", score: 8, summary: "Adoption reached 63% of teams", quote: "Adoption reached 47% of teams", locator: "abstract" },
    ]);
    const r = ledger("add-evidence", "--dir", R, "--batch", f);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("line 2 REFUSED");
    expect(r.stderr).toContain("63%");
    expect(JSON.parse(ledger("stats", "--dir", R, "--json").stdout).evidence.total).toBe(1);
  });

  test("an unknown key in a record is rejected with a suggestion", () => {
    const ids = threeSources();
    const f = batchFile("bad.jsonl", [{ source: ids[0], verdict: "include", reson: "off-topic" }]);
    const r = ledger("screen", "--dir", R, "--batch", f);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('did you mean "reason"');
  });

  test("a JSON array file works as well as JSONL", () => {
    const ids = threeSources();
    const p = `${R}/arr.json`;
    writeFileSync(p, JSON.stringify(ids.map((id) => ({ source: id, verdict: "include" })), null, 2));
    const r = ledger("screen", "--dir", R, "--batch", p);
    expect(r.code).toBe(0);
    expect(JSON.parse(ledger("stats", "--dir", R, "--json").stdout).funnel.screened).toBe(3);
  });

  test("claim and verify batch too, with array and nested values", () => {
    const ids = threeSources();
    ledger("screen", "--dir", R, "--batch", batchFile("s.jsonl", ids.map((id) => ({ source: id, verdict: "include" }))));
    ledger("add-evidence", "--dir", R, "--batch", batchFile("ev.jsonl", ids.map((id) => ({
      source: id, question: "SQ1", score: 8, summary: "Adoption grew",
      quote: "Adoption reached 47% of teams", locator: "abstract", scope_note: "survey",
    }))));
    expect(ledger("claim", "--dir", R, "--batch", batchFile("cl.jsonl", [
      { text: "Adoption is widespread", evidence: ["E001", "E002", "E003"], consensus: "strong" },
    ])).code).toBe(0);
    expect(ledger("verify", "--dir", R, "--batch", batchFile("v.jsonl", [
      { claim: "CL001", question: "Does the evidence support it?", answer: "Three sources agree", status: "supported", evidence: ["E001", "E002"] },
    ])).code).toBe(0);
    const l = JSON.parse(readFileSync(`${R}/ledger.json`, "utf8"));
    expect(l.claims[0].evidence).toEqual(["E001", "E002", "E003"]);
    expect(l.verification[0].id).toBe("V001");
  });
});

// ------------------------------------------------- mark-read --all-from-abstract

describe("mark-read --all-from-abstract", () => {
  test("every unread source with a usable abstract is stamped in one pass", () => {
    for (let n = 1; n <= 3; n++) expect(ledger("add-source", "--dir", R, "--json", source(n)).code).toBe(0);
    const r = ledger("mark-read", "--dir", R, "--all-from-abstract");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("marked 3 source(s) abstract-read of 3 unread");
    const st = JSON.parse(ledger("stats", "--dir", R, "--json").stdout);
    expect(st.funnel.read).toBe(3);
    expect(st.funnel.read_fulltext).toBe(0);
    for (const id of ["S001", "S002", "S003"]) expect(existsSync(`${R}/sources/${id}.md`)).toBe(true);
  });

  test("a source with no usable abstract is named, not silently skipped", () => {
    expect(ledger("add-source", "--dir", R, "--json", source(1)).code).toBe(0);
    expect(ledger("add-source", "--dir", R, "--json", source(2, { abstract: "too short" })).code).toBe(0);
    const r = ledger("mark-read", "--dir", R, "--all-from-abstract");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("marked 1 source(s) abstract-read of 2 unread");
    expect(r.stderr).toContain("S002");
    expect(r.stderr).toContain("unobtainable");
  });

  test("it refuses to be combined with --source", () => {
    expect(ledger("add-source", "--dir", R, "--json", source(1)).code).toBe(0);
    const r = ledger("mark-read", "--dir", R, "--all-from-abstract", "--source", "S001");
    expect(r.code).toBe(1);
  });
});

// ------------------------------------------------------------ audit: graph.json

describe("audit — graph.json", () => {
  /** A run with one included, read, full-text source and one evidence record. */
  function graphRun(graph: unknown | null, extra: string[] = []): Run {
    init();
    const id = citableSource(1, { fulltext: true });
    ledger("add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "Adoption grew among teams", "--quote", "Adoption reached 47% of teams in the surveyed population.",
      "--locator", "§3", "--scope-note", "one survey");
    if (graph !== null) writeFileSync(`${R}/graph.json`, JSON.stringify(graph, null, 2));
    return ledger("audit", "--dir", R, ...extra);
  }

  const validGraph = {
    metadata: { node_count: 2, edge_count: 1 },
    nodes: [
      { id: "n_a", label: "A", ledger_ids: ["S001", "E001"] },
      { id: "n_b", label: "B", ledger_ids: ["E001"] },
    ],
    edges: [{ source: "n_a", target: "n_b", relation: "SUPPORTS", ledger_ids: ["E001"] }],
  };

  test("a graph whose ids all resolve produces no graph findings", () => {
    const r = graphRun(validGraph);
    expect(r.stdout).not.toContain("graph-");
    expect(r.code).toBe(0);
  });

  test("a fabricated ledger id in a node is an error", () => {
    const r = graphRun({ ...validGraph, nodes: [{ id: "n_a", ledger_ids: ["S099"] }], edges: [] });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("graph-unknown-id");
  });

  test("an edge pointing at a node that does not exist is an error", () => {
    const r = graphRun({
      nodes: [{ id: "n_a", ledger_ids: ["E001"] }],
      edges: [{ source: "n_a", target: "n_missing", ledger_ids: ["E001"] }],
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("graph-dangling-edge");
  });

  test("a node with no ledger_ids is a warning, not a blocker", () => {
    const r = graphRun({ nodes: [{ id: "n_a" }], edges: [] });
    expect(r.stdout).toContain("graph-without-ledger-id");
    expect(r.code).toBe(0);
  });

  test("an id pointing at an excluded source is an error", () => {
    init();
    const id = citableSource(1, { fulltext: true });
    expect(ledger("add-source", "--dir", R, "--json", source(2)).code).toBe(0);
    expect(ledger("screen", "--dir", R, "--source", "S002", "--verdict", "exclude", "--reason", "off-topic").code).toBe(0);
    writeFileSync(`${R}/graph.json`, JSON.stringify({
      nodes: [{ id: "n_a", ledger_ids: [id] }, { id: "n_b", ledger_ids: ["S002"] }], edges: [],
    }));
    const r = ledger("audit", "--dir", R);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("graph-excluded-source");
  });

  test("unparseable JSON is an error, and --no-graph skips the file entirely", () => {
    init();
    citableSource(1, { fulltext: true });
    writeFileSync(`${R}/graph.json`, "{ not json");
    expect(ledger("audit", "--dir", R).stdout).toContain("graph-unparseable");
    expect(ledger("audit", "--dir", R, "--no-graph").stdout).not.toContain("graph-");
  });

  test("no graph.json is not a finding — stage 6 is skipped in quick mode", () => {
    const r = graphRun(null);
    expect(r.stdout).not.toContain("graph-");
  });
});

// ----------------------------------------------------- stats --md cross-check

describe("stats --md and the counting rule", () => {
  function runWithReport(transform: (block: string) => string): Run {
    init();
    const id = citableSource(1, { fulltext: true });
    ledger("add-criterion", "--dir", R, "--id", "C1", "--direction", "include", "--text", "peer reviewed");
    ledger("log-query", "--dir", R, "--q", "q", "--source", "web", "--hits", "3", "--kept", "1");
    ledger("add-evidence", "--dir", R, "--source", id, "--question", "SQ1", "--score", "8",
      "--summary", "Adoption reached 47% of teams.", "--quote", "Adoption reached 47% of teams in the surveyed population.",
      "--locator", "§3", "--scope-note", "one survey");
    const block = ledger("stats", "--dir", R, "--md").stdout;
    expect(block).toContain("<!-- drp:stats v1");
    writeFileSync(
      `${R}/REPORT.md`,
      `# Report\n\nEvidence current as of 2026-09-02.\n\nAdoption reached 47% of teams [${id}].\n\n## Method\n\n${transform(block)}\n`,
    );
    return ledger("audit", "--dir", R, "--report");
  }

  test("a freshly generated block passes, and its own numbers are not read as uncited figures", () => {
    const r = runWithReport((b) => b);
    expect(r.stdout).not.toContain("figure-without-citation");
    expect(r.stdout).not.toContain("no-stats-block");
    expect(r.stdout).toContain("0 error(s)");
    expect(r.code).toBe(0);
  });

  test("a hand-edited count is an error naming both numbers", () => {
    const r = runWithReport((b) => b.replace('"included":1', '"included":7'));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("stats-block-stale");
    expect(r.stdout).toContain("report says 7");
    expect(r.stdout).toContain("ledger says 1");
  });

  test("a report with no block at all is a warning, not a blocker", () => {
    const r = runWithReport(() => "_no counts here_");
    expect(r.stdout).toContain("no-stats-block");
    expect(r.code).toBe(0);
  });

  test("a corrupted payload is an error rather than a silent pass", () => {
    const r = runWithReport((b) => b.replace(/\{.*\}/, "{ oops"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("stats-block-unparseable");
  });
});

// ---------------------------------------------------------------- preflight

describe("scholar.ts doctor", () => {
  test("--offline reports the environment without touching the network", () => {
    const r = scholar({ OPENALEX_API_KEY: "SECRET-VALUE-123" }, "doctor", "--offline", "--json");
    expect(r.code).toBe(0);
    const d = JSON.parse(r.stdout);
    expect(d.ok).toBe(true);
    const names = d.checks.map((c: any) => c.name);
    expect(names).toContain("bun");
    expect(names).toContain("pdftotext");
    expect(names).toContain("shared cache");
    // A key is reported as present, never echoed.
    expect(r.stdout).not.toContain("SECRET-VALUE-123");
    expect(d.checks.find((c: any) => c.name === "OPENALEX_API_KEY").status).toBe("ok");
  });

  test("an unknown flag is rejected with a suggestion", () => {
    const r = scholar({}, "doctor", "--ofline");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('did you mean "offline"');
  });
});


// -------------------------------------------------------- the --dir guard

/**
 * A `--dir` that is a shell mishap rather than a path. The failure these
 * replace: `--dir System.Collections.Hashtable` used to reach `load()` and
 * surface as `no ledger at System.Collections.Hashtable/ledger.json`, which
 * reads like a corrupted run instead of a clobbered PowerShell variable.
 */
describe("the --dir guard", () => {
  test("a stringified PowerShell object is refused by name", () => {
    const r = ledger("state", "--dir", "System.Collections.Hashtable");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stringified object");
    expect(r.stderr).toContain("DRP_RUN_DIR");
    // The cause is named, not the symptom.
    expect(r.stderr).not.toContain("no ledger at");
  });

  test("a hashtable literal is refused too", () => {
    expect(ledger("state", "--dir", "@{Name=x}").stderr).toContain("stringified object");
  });

  test("an unexpanded shell variable is refused", () => {
    const r = ledger("state", "--dir", "$R");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unexpanded variable");
  });

  test("cmd-style %TEMP% is refused, because PowerShell does not expand it", () => {
    const r = ledger("state", "--dir", "%TEMP%/run");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cmd syntax");
  });

  test("--dir with no value says so instead of reporting a missing flag", () => {
    const r = ledger("stats", "--dir", "--json");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no value");
  });

  test("a real path with a $ in it is not a false positive", () => {
    // Only a leading $ is a mishap; a directory may legitimately contain one.
    init();
    const odd = `${R}/a$b`;
    mkdirSync(`${odd}/sources`, { recursive: true });
    expect(ledger("init", "--dir", odd, "--topic", "t", "--mode", "quick").code).toBe(0);
    expect(ledger("state", "--dir", odd).code).toBe(0);
  });

  test("Windows and POSIX paths both pass untouched", () => {
    init();
    expect(ledger("state", "--dir", R).code).toBe(0);
    expect(ledger("state", "--dir", R.replace(/\\/g, "/")).code).toBe(0);
  });
});

// ------------------------------------------------- the two persistent stores

describe("cross-run store versioning", () => {
  const memory = fileURLToPath(new URL("./memory.ts", import.meta.url));
  function mem(path: string, ...args: string[]): Run {
    const p = Bun.spawnSync(["bun", memory, ...args, "--path", path], {
      env: { ...process.env, DRP_CACHE_DIR: CACHE },
    });
    return {
      code: p.exitCode ?? -1,
      stdout: new TextDecoder().decode(p.stdout),
      stderr: new TextDecoder().decode(p.stderr),
    };
  }
  const memFile = () => {
    const d = mkdtempSync(`${tmpdir()}/drp-test-mem-`);
    roots.push(d);
    return `${d}/memory.md`;
  };

  test("a written memory.md carries the format marker", () => {
    const p = memFile();
    expect(mem(p, "add", "--kind", "method", "--text", "Search OpenAlex before Semantic Scholar when no key is set").code).toBe(0);
    expect(readFileSync(p, "utf8")).toContain("<!-- drp:memory v1 -->");
  });

  test("a file written before versioning still reads and writes", () => {
    const p = memFile();
    writeFileSync(p, "# Research memory\n\n## method\n- [2026-01-01] An entry from before the marker existed\n");
    const s = mem(p, "stats");
    expect(s.code).toBe(0);
    expect(s.stdout).toContain("unstamped");
    // It upgrades on the next write, and the old entry survives.
    expect(mem(p, "add", "--kind", "pitfall", "--text", "Vendor benchmarks need an interest disclosure line").code).toBe(0);
    const body = readFileSync(p, "utf8");
    expect(body).toContain("<!-- drp:memory v1 -->");
    expect(body).toContain("before the marker existed");
  });

  /**
   * The failure this prevents: the parser skips lines it does not recognise, so
   * a v1 writer rewriting a v2 file would delete whatever v2 added and report
   * success. Reading stays allowed — refusing to write is the safe half.
   */
  test("a memory.md from a newer build is read but never rewritten", () => {
    const p = memFile();
    writeFileSync(p, "# Research memory\n\n<!-- drp:memory v9 -->\n\n## method\n- [2026-01-01] Written by a newer build\n");
    expect(mem(p, "show").code).toBe(0);
    expect(mem(p, "show").stderr).toContain("v9");

    for (const args of [
      ["add", "--kind", "method", "--text", "Something this build would like to store"],
      ["forget", "--match", "newer build"],
      ["compact", "--apply"],
    ]) {
      const r = mem(p, ...args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Refusing to rewrite");
    }
    // Untouched.
    expect(readFileSync(p, "utf8")).toContain("Written by a newer build");
  });

  test("an unreadable cache misses rather than guessing, and clears cleanly", () => {
    const dir = mkdtempSync(`${tmpdir()}/drp-test-cachever-`);
    roots.push(dir);
    writeFileSync(`${dir}/doi-deadbeef.md`, "x".repeat(400));
    const inDir = (...args: string[]) => {
      const p = Bun.spawnSync(["bun", LEDGER, ...args], { env: { ...process.env, DRP_CACHE_DIR: dir } });
      return {
        code: p.exitCode ?? -1,
        stdout: new TextDecoder().decode(p.stdout),
        stderr: new TextDecoder().decode(p.stderr),
      };
    };

    // No marker: written before the format was versioned, so still readable.
    expect(inDir("cache").stdout).toContain("before the format was versioned");
    expect(inDir("cache").code).toBe(0);

    // A future format: report it, exit 1, and do not read the entries.
    writeFileSync(`${dir}/.drp-cache.json`, JSON.stringify({ version: 99, key_algo: "future", created: "2026-01-01", updated: "2026-01-01" }));
    const stale = inDir("cache");
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain("format v99");

    // Clearing it re-stamps, so the cache heals instead of staying wedged.
    expect(inDir("cache", "--prune-days", "0").code).toBe(0);
    const healed = inDir("cache");
    expect(healed.code).toBe(0);
    expect(healed.stdout).toContain("format v1");
  });
});

// ------------------------------------------------------------ doctor --strict

describe("scholar.ts doctor --strict", () => {
  test("plain doctor names what would fail strict, without failing", () => {
    const r = scholar({}, "doctor", "--offline", "--json");
    expect(r.code).toBe(0);
    const d = JSON.parse(r.stdout);
    expect(d.strict).toBe(false);
    expect(d.ok).toBe(true);
    expect(Array.isArray(d.blockers)).toBe(true);
  });

  /**
   * Only checks that change what the evidence base *can be* promote to a
   * failure. A missing API key costs throughput; a missing PDF converter costs
   * non-negotiable 13, and finding that out at stage 8 wastes the run.
   */
  test("a missing API key never blocks strict", () => {
    const r = scholar({ OPENALEX_API_KEY: "", SEMANTIC_SCHOLAR_API_KEY: "", RESEARCH_CONTACT: "" },
      "doctor", "--offline", "--strict", "--json");
    const d = JSON.parse(r.stdout);
    expect(d.blockers).not.toContain("OPENALEX_API_KEY");
    expect(d.blockers).not.toContain("SEMANTIC_SCHOLAR_API_KEY");
    expect(d.blockers).not.toContain("RESEARCH_CONTACT");
  });

  test("strict agrees with the blockers it reports", () => {
    const r = scholar({}, "doctor", "--offline", "--strict", "--json");
    const d = JSON.parse(r.stdout);
    // The environment decides whether pdftotext is present; the invariant is
    // that ok and blockers cannot disagree, and that exit code follows ok.
    expect(d.ok).toBe(d.blockers.length === 0);
    expect(r.code).toBe(d.ok ? 0 : 1);
  });

  test("--strict is a known flag", () => {
    expect(scholar({}, "doctor", "--strct").stderr).toContain('did you mean "strict"');
  });
});

// ------------------------------------------------------------ query language

describe("--query-lang is a set, not a single value", () => {
  test("init accepts a comma-separated list", () => {
    const dir = mkdtempSync(`${tmpdir()}/drp-test-qlang-`);
    roots.push(dir);
    expect(ledger("init", "--dir", dir, "--topic", "t", "--query-lang", "vi,de,ja,ru").code).toBe(0);
    const l = JSON.parse(readFileSync(`${dir}/ledger.json`, "utf8"));
    expect(l.queryLangs).toEqual(["vi", "de", "ja", "ru"]);
  });

  test("init defaults query-lang to auto when omitted", () => {
    const dir = mkdtempSync(`${tmpdir()}/drp-test-qlang-`);
    roots.push(dir);
    expect(ledger("init", "--dir", dir, "--topic", "t").code).toBe(0);
    const l = JSON.parse(readFileSync(`${dir}/ledger.json`, "utf8"));
    expect(l.queryLangs).toEqual(["auto"]);
  });

  test("init rejects a nonsense entry in the list", () => {
    const dir = mkdtempSync(`${tmpdir()}/drp-test-qlang-`);
    roots.push(dir);
    const r = ledger("init", "--dir", dir, "--topic", "t", "--query-lang", "vi,Vietnamese please");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ISO 639");
  });

  test("log-query records which language that query was issued in", () => {
    const dir = mkdtempSync(`${tmpdir()}/drp-test-qlang-`);
    roots.push(dir);
    expect(ledger("init", "--dir", dir, "--topic", "t", "--query-lang", "vi,de").code).toBe(0);
    expect(ledger("log-query", "--dir", dir, "--q", "Klimawandel Landwirtschaft", "--lang", "de").code).toBe(0);
    const l = JSON.parse(readFileSync(`${dir}/ledger.json`, "utf8"));
    expect(l.queries[0].lang).toBe("de");
  });

  test("log-query without --lang still works, recording lang: null", () => {
    const dir = mkdtempSync(`${tmpdir()}/drp-test-qlang-`);
    roots.push(dir);
    expect(ledger("init", "--dir", dir, "--topic", "t").code).toBe(0);
    expect(ledger("log-query", "--dir", dir, "--q", "test query").code).toBe(0);
    const l = JSON.parse(readFileSync(`${dir}/ledger.json`, "utf8"));
    expect(l.queries[0].lang).toBe(null);
  });

  test("log-query rejects a nonsense language", () => {
    const dir = mkdtempSync(`${tmpdir()}/drp-test-qlang-`);
    roots.push(dir);
    expect(ledger("init", "--dir", dir, "--topic", "t").code).toBe(0);
    const r = ledger("log-query", "--dir", dir, "--q", "test query", "--lang", "Vietnamese please");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ISO 639");
  });
});
