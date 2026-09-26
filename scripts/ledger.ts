#!/usr/bin/env bun
/**
 * ledger.ts — the auditable evidence ledger for the deep-research-pipeline skill.
 *
 * Holds sources, screening decisions, evidence records, the extraction
 * matrix, claims, and contradictions for one piece of research, and computes
 * every number that appears in a deliverable.
 *
 * The point of this file existing: counts in a research report must not be
 * produced by an LLM eyeballing a list. `stats` is the only legitimate source
 * of a count, and `audit` is the only legitimate source of a pass/fail.
 *
 * Run `bun ledger.ts --help` for usage.
 */

import { closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { parseArgs, validateFlags as checkFlags } from "./args.ts";
import { CACHE_VERSION, cacheDir, cacheKey, cacheList, cachePrune, cacheStatus, readCache, restamp, writeCache } from "./cache.ts";

// ----------------------------------------------------------------- schema

type Criterion = { id: string; direction: "include" | "exclude"; text: string; stage: "abstract" | "fulltext" | "metadata" };
type Source = Record<string, any> & { id: string; title: string };
type Screen = {
  source: string; stage: string; verdict: string; reason: string | null;
  criteria: Record<string, string>; quote: string | null;
  confidence: string | null; reviewer: string; at: string;
};
type Evidence = {
  id: string; source: string; question: string; summary: string;
  quote: string | null; locator: string | null; score: number;
  scope_note: string | null; at: string;
  /**
   * The reading scope of the source at the moment this record was made.
   * Stamped from `source.read_scope` rather than trusted later, because a
   * source can be upgraded to full text after the fact and that must not
   * retroactively launder an abstract's number. See non-negotiable 1.
   */
  from_scope?: "abstract" | "fulltext" | "unread";
};
type Extract = { source: string; column: string; value: string; quote: string | null; locator: string | null; at: string };
type Claim = { id: string; text: string; evidence: string[]; consensus: string; at: string };
type Contradiction = { a: string; b: string; class: string; note: string | null; at: string };
type Query = { q: string; source: string; hits: number | null; kept: number | null; lang: string | null; at: string };
/** Stage 5 (CoVe): one verification question asked of one claim, plus its answer. */
type Verification = {
  id: string; claim: string; question: string; answer: string;
  status: "supported" | "partial" | "unsupported" | "contradicted";
  evidence: string[]; note: string | null; at: string;
};

/** Which of the five gates a run has passed, and when. Written by `gate`. */
type GateRecord = { gate: string; at: string; note: string | null };

type Ledger = {
  version: number; topic: string; mode: string; lang: string; queryLangs: string[];
  created: string; updated: string;
  criteria: Criterion[]; sources: Source[]; screening: Screen[];
  evidence: Evidence[]; extraction: Extract[]; claims: Claim[];
  contradictions: Contradiction[]; queries: Query[]; verification: Verification[];
  gates?: GateRecord[];
};

const GATES = ["scope", "coverage", "sufficiency", "audit", "memory"];

const EXCLUSION_REASONS = [
  "off-topic", "wrong-population", "no-method", "outside-window",
  "wrong-language", "retracted", "duplicate", "not-primary",
  "unobtainable", "vendor-marketing", "not-peer-reviewed",
];
const CONSENSUS = ["strong", "moderate", "contested", "thin", "absent"];
const CONTRADICTION_CLASSES = ["direct", "scope", "methodological", "version-drift", "interpretive"];
const VERIFY_STATUS = ["supported", "partial", "unsupported", "contradicted"];
const KEEP_THRESHOLD = 6;  // below this, discard
const CITE_THRESHOLD = 7;  // below this, do not cite

// Any ISO 639 code, optionally with a region (en, vi, ja, pt-BR). "auto" is
// also accepted wherever a query language is expected — it means "detect
// from the topic" rather than naming a specific language.
const ISO_LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
function isValidLangTag(s: string): boolean {
  return s === "auto" || ISO_LANG_RE.test(s);
}

/**
 * Two dates, not one. `metadata_at` is stamped when an API hands back a
 * record — cheap, automatic, and no proof that anyone read anything.
 * `read_at` is stamped only by `mark-read`, which refuses unless the text is
 * cached under sources/S###.md. Non-negotiable 1 ("fetched, not glimpsed")
 * is enforced against `read_at`; a metadata hit alone can never satisfy it.
 */
const cacheFile = (dir: string, id: string) => `${dir.replace(/[\\/]+$/, "")}/sources/${id}.md`;
const MIN_CACHE_CHARS = 200;

const MODES = ["quick", "standard", "systematic", "interactive"];

/**
 * A run's filenames, declared once.
 *
 * `state` checks for these, the generated contract prints them, and the
 * reference files quote the generated block — so "is it REPORT.md or
 * report.md" has exactly one answer in the repository. Renaming one here
 * renames it everywhere that matters.
 */
const RUN_FILES = {
  brief: "00-brief.md", plan: "01-plan.md", searchLog: "02-search-log.md",
  screening: "03-screening.md", extraction: "03-extraction.md",
  synthesis: "04-synthesis.md", verification: "05-verification.md",
  graphMd: "06-knowledge-graph.md", graph: "graph.json",
  refineLog: "07-refine-log.md", report: "REPORT.md", gaps: "gaps.md",
  audit: "08-audit.md", bib: "references-list.md", stats: "stats.json",
  ledger: "ledger.json",
} as const;

const RUN_FILE_NOTES: [string, string][] = [
  [RUN_FILES.brief, "question, framing, criteria, perspectives"],
  [RUN_FILES.plan, "outline, sub-queries, routes, targets"],
  [RUN_FILES.searchLog, "every query: source, hits, kept"],
  [RUN_FILES.screening, "include/exclude decisions + PRISMA funnel"],
  [RUN_FILES.extraction, "extraction matrix (ledger.ts matrix)"],
  [RUN_FILES.synthesis, "perspectives, debate, findings, contradictions"],
  [RUN_FILES.verification, "CoVe questions, Reflexion changes"],
  [RUN_FILES.graphMd, "entity-relation map, structural gaps"],
  [RUN_FILES.graph, "nodes + edges, ledger_ids on each (audit checks them)"],
  [RUN_FILES.refineLog, "Self-Refine iterations, score history"],
  [RUN_FILES.report, "the deliverable, fully cited (uppercase, case-sensitive)"],
  [RUN_FILES.gaps, "open questions, what to research next"],
  [RUN_FILES.audit, "stats + audit output, shown to the user"],
  [RUN_FILES.bib, "bibliography (ledger.ts bib)"],
  [RUN_FILES.stats, "counts (ledger.ts stats --json)"],
  [RUN_FILES.ledger, "single source of truth — only ledger.ts writes it"],
  ["raw/", "executor JSON returns, merged via add-source --file"],
  ["sources/S###.md", "cached source text — required before a source is citable"],
];

/**
 * Every rule the scripts enforce, declared once and rendered by `contract`.
 *
 * The reference files used to restate these by hand, which is how a doc ends
 * up claiming a threshold the code stopped using. Values interpolate from the
 * same constants the checks read, so a number here cannot drift from a number
 * there.
 */
const THRESHOLDS: [rule: string, value: string, where: string, severity: string][] = [
  ["Keep an evidence record", `score ≥ ${KEEP_THRESHOLD}`, "add-evidence", "refuses below (exit 2)"],
  ["Cite an evidence record", `score ≥ ${CITE_THRESHOLD}`, "audit", "warns below"],
  ["A number in a summary", "must appear in its quote", "add-evidence", "**refuses (exit 2)**"],
  ["A number in a summary", "must appear in its quote", "audit", "error"],
  ["Abstract-only evidence, `systematic`", `capped at score ${KEEP_THRESHOLD}`, "add-evidence", "caps, loudly"],
  ["A figure backing a claim", "needs a full-text source", "audit", "error (warn in `quick`)"],
  ["Cached text per source", `≥ ${MIN_CACHE_CHARS} chars`, "mark-read", "refuses below"],
  ["`strong` consensus", "≥ 3 independent sources", "audit", "error"],
  ["Single-source claim", "must be `thin` or `absent`", "audit", "error"],
  ["Cited source", "must have `read_at`", "audit", "error"],
  ["Included source", "needs `read_at` + a live cache file", "audit", "error"],
  ["Retracted source", "may not be included", "audit", "error"],
  ["Claim verified `unsupported`", "may not ship", "audit", "error"],
  ["Claim verified `contradicted`", "needs a `contradiction` record", "audit", "error"],
  ["`[S###]` in the report", "must exist, be included, and be read", "audit --report", "error"],
  ["A figure in a paragraph", "needs a citation in that paragraph", "audit --report", "error"],
  ["A figure in the report", "may not rest only on abstract-only sources", "audit --report", "error (warn in `quick`)"],
  ["Currency line", "`Evidence current as of …` or the `drp:as-of` marker", "audit --report", "error"],
  ["A `drp:stats` count in the report", "must match the ledger", "audit --report", "error"],
  ["A `drp:stats` block", "should be present at all", "audit --report", "warning"],
  ["`graph.json` `ledger_ids`", "must exist, be included, be read", "audit", "error"],
  ["`graph.json` edge endpoint", "must be a node in the same file", "audit", "error"],
  ["`graph.json` node or edge", "should carry `ledger_ids`", "audit", "warning"],
  ["Gate `scope` before evidence exists", "record it with `gate --pass`", "audit", "warning (error in `systematic`)"],
  ["Gates `coverage` / `sufficiency`", "recorded before delivery", "audit --report", "warning (error in `systematic`)"],
  ["Excluded as `unobtainable`", "≥ 15% of screened (and ≥ 3)", "audit", "warning"],
  ["Included but abstract-only", "≥ 50% of included", "audit", "warning"],
  ["`strong`/`moderate` claim", "sources should not share authors or venue", "audit", "warning"],
  ["Criterion id", "may not be re-registered", "add-criterion", "refuses"],
  ["An unknown flag or batch key", "rejected with a suggestion", "every command", "refuses, writes nothing"],
  ["A `--dir` that is a stringified object or an unexpanded variable", "rejected before any write", "every command", "refuses, writes nothing"],
];

// --------------------------------------------------------------- plumbing

const now = () => new Date().toISOString();
const out = (s: string) => process.stdout.write(s + "\n");
const warn = (s: string) => process.stderr.write(`  ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A refusal, not a crash. Exit 2 means "the tool understood you and declined"
 * — the same convention memory.ts uses for "nothing to remember". Reserve it
 * for rules the agent must not be able to shrug off by retrying.
 */
class Refusal extends Error {
  readonly code = 2;
}

/**
 * Every flag each command accepts. Validation lives in args.ts; this table is
 * the contract, and it must match HELP below — a flag that is not in --help
 * does not exist.
 */
const FLAGS: Record<string, string[]> = {
  "init": ["dir", "topic", "mode", "lang", "query-lang"],
  "add-criterion": ["dir", "id", "direction", "text", "stage"],
  "add-source": ["dir", "file", "json", "from"],
  "mark-read": ["dir", "source", "from-abstract", "all-from-abstract", "file", "scope", "no-cache", "at"],
  "log-query": ["dir", "q", "source", "hits", "kept", "lang"],
  "screen": ["dir", "batch", "source", "verdict", "stage", "criteria", "reason", "quote", "confidence", "reviewer"],
  "add-evidence": ["dir", "batch", "source", "question", "score", "summary", "quote", "locator", "scope-note"],
  "contradiction": ["dir", "a", "b", "class", "note"],
  "extract": ["dir", "batch", "source", "col", "value", "quote", "locator"],
  "claim": ["dir", "batch", "id", "text", "evidence", "consensus"],
  "verify": ["dir", "batch", "claim", "question", "answer", "status", "evidence", "note"],
  "stats": ["dir", "json", "md"],
  "audit": ["dir", "json", "report", "graph", "no-graph"],
  "matrix": ["dir"],
  "bib": ["dir"],
  "state": ["dir", "json"],
  "gate": ["dir", "pass", "note"],
  "cache": ["list", "prune-days"],
  "contract": ["md", "check"],
};

/** Commands that accept `--batch F.jsonl` — one lock, one write, many records. */
const BATCHABLE = ["screen", "add-evidence", "extract", "claim", "verify"];

const validateFlags = (cmd: string, o: Record<string, unknown>, inRecord = false) => checkFlags(cmd, o, FLAGS, inRecord);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const need = (o: Record<string, any>, k: string): string => {
  const v = str(o[k]);
  if (!v) throw new Error(`--${k} is required`);
  return v;
};
const ledgerPath = (dir: string) => `${dir.replace(/[\\/]+$/, "")}/ledger.json`;

/**
 * A `--dir` that cannot be a directory, caught at the front door.
 *
 * The failure this removes: PowerShell variable names are case-insensitive, so
 * `foreach ($r in $rows)` clobbers `$R`, and `--dir $R` then arrives as the
 * *type name* of whatever object the loop held. Every later command failed with
 * `no ledger at System.Collections.Hashtable/ledger.json`, which reads like a
 * corrupted run rather than a shell footgun, and the reference files had to
 * warn about it twice in prose. A guard that names the cause costs one line and
 * ends the class of bug.
 *
 * Three shapes, all of them a shell mishap rather than a path:
 *  - a stringified object: `System.…`, `Microsoft.PowerShell.…`, `@{a=1}`
 *  - an unexpanded variable: a leading `$` (the shell did not substitute), or
 *    `%TEMP%` (cmd syntax, which PowerShell leaves as a literal folder name)
 *  - nothing at all: `--dir` immediately followed by another flag
 */
const SHELL_OBJECT = /^(?:System\.[\w.+[\]`]+|Microsoft\.PowerShell\.[\w.]+|@\{.*\})$/;
const UNEXPANDED_VAR = /%[A-Za-z_][A-Za-z0-9_]*%/;

const DIR_FIX =
  `  Set the run directory once instead of passing it every call:\n` +
  `    PowerShell  $env:DRP_RUN_DIR = "research/<date>-<slug>"\n` +
  `    POSIX       export DRP_RUN_DIR="research/<date>-<slug>"\n` +
  `  and name loop variables $rec / $sid / $row, never $r — PowerShell variable\n` +
  `  names are case-insensitive, so $r and $R are the same variable.`;

function checkRunDir(v: unknown): void {
  if (v === undefined) return;
  if (v === true) {
    throw new Error(`--dir was given with no value — the next argument was another flag.\n${DIR_FIX}`);
  }
  if (typeof v !== "string") return;
  const d = v.trim();
  if (!d) throw new Error(`--dir is empty — the variable holding it expanded to nothing.\n${DIR_FIX}`);
  if (SHELL_OBJECT.test(d)) {
    throw new Error(
      `--dir is "${d}", which is a stringified object, not a directory.\n` +
      `  A shell variable holding the run directory was overwritten with something else.\n${DIR_FIX}`,
    );
  }
  if (d.startsWith("$") || UNEXPANDED_VAR.test(d)) {
    throw new Error(
      `--dir is "${d}", which still contains an unexpanded variable.\n` +
      `  The shell passed the text through instead of substituting a value` +
      (UNEXPANDED_VAR.test(d) ? ` — %NAME% is cmd syntax and PowerShell treats it as a literal folder name.` : `.`) +
      `\n${DIR_FIX}`,
    );
  }
}

async function load(dir: string): Promise<Ledger> {
  const p = ledgerPath(dir);
  const f = Bun.file(p);
  if (!(await f.exists())) throw new Error(`no ledger at ${p} — run 'ledger.ts init --dir ${dir}' first`);
  const l = JSON.parse(await f.text()) as Ledger;
  // Backfill fields added after a ledger was created, so an older run keeps working.
  l.verification ??= [];
  l.gates ??= [];
  l.queryLangs ??= ["auto"];
  for (const q of l.queries) q.lang ??= null;
  // Migration: `fetched` used to mean both "metadata arrived" and "I read it".
  // Old records keep the weaker meaning — an agent must re-assert reading via
  // mark-read rather than inherit a citable flag it never earned.
  for (const s of l.sources) {
    if (s.fetched != null && s.metadata_at == null) s.metadata_at = s.fetched;
    if (s.metadata_at === undefined) s.metadata_at = null;
    if (s.read_at === undefined) s.read_at = null;
    delete s.fetched;
  }
  return l;
}

/**
 * Every write goes temp-file-then-rename, so a reader never sees half a
 * ledger and a crash mid-write cannot truncate the only copy of the run.
 * `rename` is atomic on NTFS and POSIX alike.
 */
async function save(dir: string, l: Ledger) {
  l.updated = now();
  const p = ledgerPath(dir);
  const tmp = `${p}.tmp-${process.pid}`;
  await Bun.write(tmp, JSON.stringify(l, null, 2));
  renameSync(tmp, p);
}

// ------------------------------------------------------------------- lock

/**
 * One writer at a time.
 *
 * Every mutating command is read-modify-write, and stage 2 fans retrieval out
 * to parallel subagents that all call `add-source`. Without this, two
 * concurrent calls both read the same ledger and the second `save` silently
 * discards the first one's sources — the failure mode you only notice when
 * the funnel count is short and you cannot say why.
 *
 * A lock is an exclusively-created file, which is atomic on every platform.
 * Stale locks (a killed process) expire so a run can never be wedged by a
 * crash; the wait is bounded so a real deadlock reports itself instead of
 * hanging the agent.
 */
const lockPath = (dir: string) => `${dir.replace(/[\\/]+$/, "")}/ledger.lock`;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

async function acquireLock(dir: string): Promise<() => void> {
  const lp = lockPath(dir);
  mkdirSync(dir.replace(/[\\/]+$/, ""), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lp, "wx");           // fails if it already exists
      writeSync(fd, `pid ${process.pid} at ${now()}\n`);
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { unlinkSync(lp); } catch { /* someone reaped it as stale */ }
      };
    } catch (e: any) {
      // EEXIST: another writer holds the lock. EPERM/EACCES/EBUSY: on NTFS a
      // file that is being deleted right now reports as a permission error
      // rather than as "exists", so those are contention too — the very case
      // this lock exists for (parallel executor merges). Treating them as
      // fatal killed one writer in ~1 of 6 sixteen-way fan-outs, and the
      // record it was carrying was simply lost.
      const code = e?.code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw e;
      try {
        if (Date.now() - statSync(lp).mtimeMs > LOCK_STALE_MS) {
          warn(`clearing a stale ledger lock (older than ${LOCK_STALE_MS / 1000}s)`);
          unlinkSync(lp);
          continue;
        }
      } catch { continue; }                     // vanished between stat and now
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error(`ledger is locked by another writer after ${LOCK_WAIT_MS / 1000}s (last error ${code}): ${lp}. If nothing else is running, delete that file`);
      }
      await sleep(40 + Math.random() * 120);    // jitter: parallel executors
    }
  }
}

const nextId = (prefix: string, existing: string[]): string => {
  let n = 0;
  for (const e of existing) {
    const m = e.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `${prefix}${String(n + 1).padStart(3, "0")}`;
};

/** Latest decision per source wins, per reviewer. */
function verdictsFor(l: Ledger, reviewer: string): Map<string, Screen> {
  const m = new Map<string, Screen>();
  for (const s of l.screening) if (s.reviewer === reviewer) m.set(s.source, s);
  return m;
}

const includedSources = (l: Ledger): Source[] => {
  const v = verdictsFor(l, "pass1");
  return l.sources.filter((s) => v.get(s.id)?.verdict === "include");
};

// ------------------------------------------------------------------- batch

/**
 * One record applied to an in-memory ledger. Returns what to print; it must
 * not save, because the whole point of the batch path is that fifty records
 * cost one lock, one parse, and one write instead of fifty of each.
 *
 * The cost this removes is not disk time (a single call is ~0.2s) but agent
 * turns: every CLI call is a round trip that re-sends the conversation, so a
 * systematic run screening 60 sources and extracting 8 columns each used to
 * spend several hundred turns on bookkeeping alone.
 */
type Applied = { line: string; warns?: string[] };
type Apply = (l: Ledger, o: Record<string, any>, dir: string) => Applied | Promise<Applied>;

type BatchLine = { lineNo: number; text?: string; rec?: any };

/** JSONL (one object per line) or a JSON array. Blank lines and #/// comments skipped. */
function parseBatch(raw: string): BatchLine[] {
  const t = raw.trim();
  if (!t) throw new Error("the batch file is empty");
  if (t.startsWith("[")) {
    const arr = JSON.parse(t);
    if (!Array.isArray(arr)) throw new Error("a JSON batch file must hold an array of objects");
    if (!arr.length) throw new Error("the batch array is empty");
    return arr.map((rec, i) => ({ lineNo: i + 1, rec }));
  }
  const lines = raw.split(/\r?\n/);
  const outp: BatchLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s.startsWith("//") || s.startsWith("#")) continue;
    outp.push({ lineNo: i + 1, text: s });
  }
  if (!outp.length) throw new Error("no records in the batch file — expected one JSON object per line");
  return outp;
}

/**
 * Turn a batch record into the shape parseArgs would have produced, so the
 * apply function cannot tell the two paths apart:
 *   {"source":"S001","score":8,"scope_note":"…"}  ->  --source S001 --score 8 --scope-note "…"
 * Arrays join with commas (`evidence`), objects become "k:v" pairs (`criteria`).
 */
function recordToFlags(rec: any, lineNo: number): Record<string, any> {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
    throw new Error(`expected a JSON object, got ${Array.isArray(rec) ? "an array" : typeof rec}`);
  }
  const o: Record<string, any> = {};
  for (const [kRaw, v] of Object.entries(rec)) {
    if (v === null || v === undefined) continue;
    const k = kRaw.replace(/_/g, "-");
    if (Array.isArray(v)) o[k] = v.map((x) => String(x)).join(",");
    else if (typeof v === "object") o[k] = Object.entries(v as Record<string, unknown>).map(([a, b]) => `${a}:${b}`).join(",");
    else if (typeof v === "boolean") o[k] = v;
    else o[k] = String(v);
  }
  void lineNo;
  return o;
}

/**
 * Single record or `--batch`, same validation either way.
 *
 * Batch semantics, stated because they matter for auditability: every line is
 * attempted, the lines that succeed are written, the lines that fail are named
 * with their line number and are NOT written. Exit 2 if any line was refused
 * by a rule, 1 if any line errored, 0 only when every line landed. Fix the
 * named lines and resubmit just those.
 */
async function runCmd(cmd: string, o: Record<string, any>, apply: Apply) {
  const dir = need(o, "dir");
  const l = await load(dir);
  const batch = str(o.batch);

  if (!batch) {
    const r = await apply(l, o, dir);
    await save(dir, l);
    out(r.line);
    for (const w of r.warns ?? []) warn(w);
    return;
  }

  const f = Bun.file(batch);
  if (!(await f.exists())) throw new Error(`no batch file at ${batch}`);
  const records = parseBatch(await f.text());

  let applied = 0, refused = 0, failed = 0;
  const problems: string[] = [];
  const warns: string[] = [];
  for (const entry of records) {
    try {
      let rec = entry.rec;
      if (rec === undefined) {
        try { rec = JSON.parse(entry.text!); }
        catch (e) { throw new Error(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`); }
      }
      const ro = recordToFlags(rec, entry.lineNo);
      validateFlags(cmd, ro, true);
      const r = await apply(l, ro, dir);
      applied++;
      out(`  line ${String(entry.lineNo).padStart(4)}  ${r.line}`);
      for (const w of r.warns ?? []) warns.push(`line ${entry.lineNo}: ${w}`);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      if (e instanceof Refusal) { refused++; problems.push(`line ${entry.lineNo} REFUSED: ${msg}`); }
      else { failed++; problems.push(`line ${entry.lineNo} ERROR: ${msg}`); }
    }
  }

  if (applied) await save(dir, l);
  out(`\n${cmd} --batch: ${applied} applied, ${refused} refused, ${failed} failed, of ${records.length} record(s)`);
  for (const w of warns.slice(0, 40)) warn(w);
  if (warns.length > 40) warn(`… and ${warns.length - 40} more warning(s)`);
  for (const p of problems.slice(0, 40)) warn(p);
  if (problems.length > 40) warn(`… and ${problems.length - 40} more rejected line(s)`);
  if (problems.length) {
    warn(`the ${problems.length} rejected line(s) were not written — fix them and resubmit just those lines`);
    if (refused) throw new Refusal(`${refused} line(s) refused by design${failed ? `, ${failed} errored` : ""}`);
    throw new Error(`${failed} line(s) failed`);
  }
}

// -------------------------------------------------------------- commands

async function cmdInit(o: Record<string, any>) {
  const dir = need(o, "dir");
  const p = ledgerPath(dir);
  if (await Bun.file(p).exists()) throw new Error(`ledger already exists at ${p} — refusing to overwrite`);
  const mode = str(o.mode) ?? "standard";
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of: ${MODES.join(", ")} (there is no "exhaustive" mode; deeper than standard is systematic)`);
  // Any ISO 639 code, optionally with a region. The deliverable language is not
  // the skill's business beyond writing it down — an en/vi allow-list only ever
  // stopped someone researching in their own language.
  const lang = str(o.lang) ?? "en";
  if (!ISO_LANG_RE.test(lang)) {
    throw new Error(`--lang must be an ISO 639 code, optionally with a region: en, vi, ja, pt-BR`);
  }
  // --query-lang is a separate axis from --lang: which language(s) to search
  // in, not what the deliverable is written in. Comma-separated, or "auto" to
  // detect from the topic (the default — unset means the same thing it always
  // has).
  const queryLangRaw = str(o["query-lang"]) ?? "auto";
  const queryLangs = [...new Set(queryLangRaw.split(",").map((s) => s.trim()).filter(Boolean))];
  const badQueryLangs = queryLangs.filter((s) => !isValidLangTag(s));
  if (!queryLangs.length || badQueryLangs.length) {
    throw new Error(`--query-lang must be "auto" or a comma-separated list of ISO 639 codes: vi,de,ja,ru${badQueryLangs.length ? ` (bad: ${badQueryLangs.join(", ")})` : ""}`);
  }
  const l: Ledger = {
    version: 1, topic: str(o.topic) ?? "", mode,
    lang, queryLangs, created: now(), updated: now(),
    criteria: [], sources: [], screening: [], evidence: [],
    extraction: [], claims: [], contradictions: [], queries: [], verification: [],
    gates: [],
  };
  await save(dir, l);
  out(`initialised ledger at ${p}`);
  warn(`topic: ${l.topic || "(not set)"} | mode: ${l.mode} | lang: ${l.lang} | query-langs: ${l.queryLangs.join(", ")}`);
}

async function cmdAddCriterion(o: Record<string, any>) {
  const dir = need(o, "dir");
  const l = await load(dir);
  const id = need(o, "id");
  const direction = need(o, "direction") as Criterion["direction"];
  if (!["include", "exclude"].includes(direction)) throw new Error("--direction must be include or exclude");
  const stage = (str(o.stage) ?? "abstract") as Criterion["stage"];
  if (!["abstract", "fulltext", "metadata"].includes(stage)) throw new Error("--stage must be abstract, fulltext, or metadata");
  if (l.criteria.some((c) => c.id === id)) throw new Error(`criterion ${id} already exists — criteria are pre-registered and must not be silently changed`);
  l.criteria.push({ id, direction, text: need(o, "text"), stage });
  await save(dir, l);
  out(`registered ${id} (${direction}, ${stage} stage)`);
}

/**
 * The sources/S###.md file an abstract-only reading produces. Same header
 * whether one source or the whole ledger is being stamped, so a run's cache
 * files look identical however they were made.
 */
function abstractDoc(s: Source, id: string): string {
  return [
    `# ${s.title ?? id}`, "",
    `- id: ${id}`,
    `- year: ${s.year ?? "?"}`,
    s.doi ? `- doi: ${s.doi}` : null,
    s.url ? `- url: ${s.url}` : null,
    `- cached: abstract only (metadata API), ${now().slice(0, 10)}`,
    "", "## Abstract", "", str(s.abstract) ?? "", "",
  ].filter(Boolean).join("\n");
}

/**
 * Accepts either scholar.ts output ({records:[…]}) or the executor return
 * contract from references/executor-contract.md ({sources:[…]}).
 * Dedups against what is already in the ledger and never re-issues an id.
 */
async function cmdAddSource(o: Record<string, any>) {
  const dir = need(o, "dir");
  const l = await load(dir);
  const from = str(o.from) ?? "unknown";
  let incoming: any[] = [];

  if (o.file) {
    const j = JSON.parse(await Bun.file(need(o, "file")).text());
    incoming = j.records ?? j.sources ?? (Array.isArray(j) ? j : []);
  } else if (o.json) {
    const j = JSON.parse(need(o, "json"));
    incoming = Array.isArray(j) ? j : [j];
  } else {
    throw new Error("--file or --json is required");
  }

  const keyOf = (r: any): string[] => {
    const k: string[] = [];
    const doi = r.doi ? String(r.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() : null;
    if (doi) k.push(`doi:${doi}`);
    if (r.pmid) k.push(`pmid:${r.pmid}`);
    if (r.arxiv) k.push(`arxiv:${r.arxiv}`);
    if (r.openalex) k.push(`oa:${r.openalex}`);
    if (r.url) k.push(`url:${String(r.url).replace(/[#?].*$/, "").toLowerCase()}`);
    const t = String(r.title ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    if (t.length > 15) k.push(`title:${t}|${r.year ?? r.published ?? "?"}`);
    return k;
  };

  const index = new Map<string, string>();
  for (const s of l.sources) for (const k of keyOf(s)) index.set(k, s.id);

  let added = 0, merged = 0, unfetched = 0;
  for (const r of incoming) {
    const hitId = keyOf(r).map((k) => index.get(k)).find(Boolean);
    if (hitId) {
      const tgt = l.sources.find((s) => s.id === hitId)!;
      tgt.found_by = [...new Set([...(tgt.found_by ?? []), ...(r.found_by ?? []), r.query].filter(Boolean))];
      for (const f of ["doi", "pmid", "arxiv", "openalex", "url", "oa_url", "abstract", "year", "venue", "metadata_at", "read_at"]) {
        if (tgt[f] == null && r[f] != null) tgt[f] = r[f];
      }
      merged++;
      continue;
    }
    const id = nextId("S", l.sources.map((s) => s.id));
    const rec: Source = {
      ...r, id,
      source_api: r.source_api ?? from,
      kind: r.kind ?? "unknown",
      // The executor contract calls these `published` / `accessed`.
      year: r.year ?? (r.published ? Number(String(r.published).slice(0, 4)) : null),
      // An API response proves metadata arrived, nothing more. Reading is
      // asserted separately by `mark-read`, which checks the cache file.
      metadata_at: r.metadata_at ?? r.fetched ?? r.accessed ?? null,
      read_at: r.read_at ?? null,
      interest_disclosure: r.interest_disclosure ?? "unclear",
      anomalies: r.anomalies ?? [],
      found_by: [...new Set([...(r.found_by ?? []), r.query].filter(Boolean))],
    };
    delete rec.fetched;
    delete rec.accessed;
    if (!rec.metadata_at) unfetched++;
    l.sources.push(rec);
    for (const k of keyOf(rec)) index.set(k, id);
    added++;
  }
  await save(dir, l);
  out(`added ${added}, merged ${merged} into existing, ${l.sources.length} total`);
  if (unfetched) warn(`${unfetched} added with no metadata date at all — not even a lead yet`);
  out(`none of these are citable until 'mark-read' confirms the text is cached under sources/ (non-negotiable 1)`);
  const flagged = l.sources.filter((s) => (s.anomalies ?? []).length);
  if (flagged.length) warn(`${flagged.length} source(s) carry metadata anomalies — check before citing: ${flagged.map((s) => s.id).join(", ")}`);
}

/**
 * The mechanical half of non-negotiable 1. A source becomes citable only when
 * its text sits on disk at sources/S###.md, so a quote can still be checked
 * after the page changes or dies. `--from-abstract` makes the honest path
 * one command: it writes the abstract the ledger already holds. There is no
 * flag that sets read_at without a cache file, by design.
 */
async function cmdMarkRead(o: Record<string, any>) {
  const dir = need(o, "dir");
  const l = await load(dir);

  if (o["all-from-abstract"]) {
    if (o.source || o.file) throw new Error("--all-from-abstract works on the whole ledger — drop --source and --file");
    const pending = l.sources.filter((s) => !s.read_at);
    if (!l.sources.length) throw new Error("the ledger holds no sources yet — run 'add-source' first (stage 2)");
    if (!pending.length) throw new Error("every source already has read_at — nothing to do");
    let done = 0;
    const skipped: string[] = [];
    for (const s of pending) {
      const abs = str(s.abstract);
      if (!abs || abs.length < MIN_CACHE_CHARS) {
        skipped.push(`${s.id} (${abs?.length ?? 0} chars)`);
        continue;
      }
      await Bun.write(cacheFile(dir, s.id), abstractDoc(s, s.id));
      const text = (await Bun.file(cacheFile(dir, s.id)).text()).trim();
      s.read_at = str(o.at) ?? now().slice(0, 10);
      s.read_scope = "abstract";
      s.cache_chars = text.length;
      if (!s.metadata_at) s.metadata_at = s.read_at;
      done++;
      out(`${s.id}: read_at ${s.read_at} (abstract, ${s.cache_chars} chars cached)`);
    }
    if (done) await save(dir, l);
    out(`\nmarked ${done} source(s) abstract-read of ${pending.length} unread`);
    if (skipped.length) {
      warn(`${skipped.length} source(s) have no usable abstract: ${skipped.slice(0, 15).join(", ")}${skipped.length > 15 ? ", …" : ""}`);
      warn(`fetch their text ('scholar.ts fetch') or screen them out as unobtainable — leaving them unread blocks the coverage gate`);
    }
    if (done) warn(`all ${done} are abstract-only: no figure may rest on them (non-negotiable 13), and systematic mode caps their evidence at ${KEEP_THRESHOLD}`);
    return;
  }

  const id = need(o, "source");
  const s = l.sources.find((x) => x.id === id);
  if (!s) throw new Error(`unknown source ${id}`);
  const path = str(o.file) ?? cacheFile(dir, id);
  const key = cacheKey(s);
  let reused = false;

  if (o["from-abstract"]) {
    const abs = str(s.abstract);
    if (!abs || abs.length < MIN_CACHE_CHARS) {
      throw new Error(`${id} has no usable abstract to cache (${abs?.length ?? 0} chars) — fetch the page and write ${path} yourself`);
    }
    await Bun.write(path, abstractDoc(s, id));
  } else if (!o["no-cache"] && !(await Bun.file(path).exists())) {
    // Cross-run cache: another run already fetched this DOI. Copy it into this
    // run's sources/ rather than re-fetching — the run still keeps its own
    // copy, so it stays auditable once the cache is pruned.
    const hit = await readCache(key);
    if (hit && key) {
      await Bun.write(path, restamp(hit, id, key));
      reused = true;
    }
  }

  const f = Bun.file(path);
  if (!(await f.exists())) {
    throw new Error(`no cached text at ${path} — fetch the source and save its text there first (scholar.ts fetch does it for a DOI), or pass --from-abstract to cache the abstract`);
  }
  const text = await f.text();
  if (text.trim().length < MIN_CACHE_CHARS) {
    throw new Error(`${path} holds only ${text.trim().length} chars — that is a stub, not a source. Non-negotiable 1 wants the text you actually read`);
  }

  s.read_at = str(o.at) ?? now().slice(0, 10);
  s.read_scope = str(o.scope) ?? (o["from-abstract"] ? "abstract" : "fulltext");
  s.cache_chars = text.trim().length;
  if (!s.metadata_at) s.metadata_at = s.read_at;
  await save(dir, l);
  out(`${id}: read_at ${s.read_at} (${s.read_scope}, ${s.cache_chars} chars cached${reused ? ", reused from the shared cache" : ""})`);
  if (s.read_scope === "abstract") warn(`abstract-only — a number quoted from it is an abstract's number, and add-evidence will hold such a record to context-only in systematic mode. 'scholar.ts fetch' resolves full text when an OA copy exists`);
  // Feed the shared cache so the next run on a neighbouring topic gets a hit.
  if (!reused && !o["no-cache"] && s.read_scope !== "abstract") {
    const p = await writeCache(key, text);
    if (p) warn(`shared cache updated: ${p}`);
  }
}

function applyScreen(l: Ledger, o: Record<string, any>): Applied {
  const source = need(o, "source");
  if (!l.sources.some((s) => s.id === source)) throw new Error(`unknown source ${source}`);
  const verdict = need(o, "verdict");
  if (!["include", "exclude", "defer"].includes(verdict)) throw new Error("--verdict must be include, exclude, or defer");
  const reason = str(o.reason) ?? null;
  if (verdict === "exclude") {
    if (!reason) throw new Error(`--reason is required when excluding (one of: ${EXCLUSION_REASONS.join(", ")})`);
    if (!EXCLUSION_REASONS.includes(reason)) throw new Error(`--reason must be one of: ${EXCLUSION_REASONS.join(", ")}`);
  }
  const criteria: Record<string, string> = {};
  for (const pair of (str(o.criteria) ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = pair.split(":");
    if (!k || !v) throw new Error(`--criteria expects "C1:pass,C2:fail", got "${pair}"`);
    if (l.criteria.length && !l.criteria.some((c) => c.id === k)) throw new Error(`criterion ${k} was never registered — pre-register it or fix the id`);
    criteria[k] = v;
  }
  l.screening.push({
    source, stage: str(o.stage) ?? "abstract", verdict, reason, criteria,
    quote: str(o.quote) ?? null, confidence: str(o.confidence) ?? null,
    reviewer: str(o.reviewer) ?? "pass1", at: now(),
  });
  return { line: `${source}: ${verdict}${reason ? ` (${reason})` : ""} at ${str(o.stage) ?? "abstract"} stage by ${str(o.reviewer) ?? "pass1"}` };
}

const cmdScreen = (o: Record<string, any>) => runCmd("screen", o, applyScreen);

function applyAddEvidence(l: Ledger, o: Record<string, any>, dir: string): Applied {
  const warns: string[] = [];
  const source = need(o, "source");
  const src = l.sources.find((s) => s.id === source);
  if (!src) throw new Error(`unknown source ${source}`);
  if (!src.read_at) warns.push(`${source} has no read_at — run 'mark-read' first, or this evidence is not citable`);
  let score = Number(need(o, "score"));
  if (!Number.isFinite(score) || score < 1 || score > 10) throw new Error("--score must be 1-10");
  // ledger.md advertises this as enforced, so enforce it. A sub-6 record is
  // noise that later inflates every count it appears in.
  if (score < KEEP_THRESHOLD) {
    throw new Error(`score ${score} is below the keep threshold of ${KEEP_THRESHOLD} — discard it rather than keeping it "just in case" (raise the score only if the passage really is more relevant than that)`);
  }
  const id = nextId("E", l.evidence.map((e) => e.id));
  const quote = str(o.quote) ?? null;
  const summary = need(o, "summary");
  const fromScope: Evidence["from_scope"] =
    !src.read_at ? "unread" : src.read_scope === "abstract" ? "abstract" : "fulltext";

  // Non-negotiable 4, moved from stage 8 to the moment the record is made.
  // The audit catches this too, but by then the claim is written, verified,
  // and cited — the same fix costs an order of magnitude more.
  if (quote) {
    const missing = numbersMissingFrom(summary, quote);
    if (missing.length) {
      throw new Refusal(
        `refused: ${missing.map((m) => `"${m}"`).join(", ")} ${missing.length > 1 ? "appear" : "appears"} in the summary but not in the quote.\n` +
        `  Fix one of the two, do not weaken the rule:\n` +
        `   - extend --quote so it contains the figure (an ellipsis between two passages of the same page is fine),\n` +
        `   - or drop the figure from --summary and describe the finding qualitatively.\n` +
        `  A converted unit counts as absent: a quote of "0.87" does not license a summary of "87%".`,
      );
    }
  }

  // Systematic mode declares full text mandatory for included sources, so an
  // abstract cannot yield cite-grade evidence there. Cap rather than refuse:
  // the record is still worth keeping as context, and the cap is loud.
  if (fromScope === "abstract" && l.mode === "systematic" && score > KEEP_THRESHOLD) {
    warns.push(`score capped ${score} -> ${KEEP_THRESHOLD}: ${source} is abstract-only and this run is systematic mode, where cite-grade evidence needs full text (try 'scholar.ts fetch --id <doi> --out ${cacheFile(dir, source)}', then 'mark-read --scope fulltext')`);
    score = KEEP_THRESHOLD;
  }

  l.evidence.push({
    id, source, question: need(o, "question"), summary, quote,
    locator: str(o.locator) ?? null, score,
    scope_note: str(o["scope-note"]) ?? null, at: now(), from_scope: fromScope,
  });
  if (score < CITE_THRESHOLD) warns.push(`score ${score} is usable as context but below the cite threshold of ${CITE_THRESHOLD}`);
  if (!quote) warns.push("no quote recorded — any number in this summary is unverifiable");
  else if (fromScope === "abstract" && numbersIn(summary).length) {
    warns.push(`this record takes a number from an abstract — the audit reports that, and an abstract rarely carries the method context a figure needs`);
  }
  return { line: `${id}: ${source} -> ${need(o, "question")} (score ${score}, ${fromScope})`, warns };
}

const cmdAddEvidence = (o: Record<string, any>) => runCmd("add-evidence", o, applyAddEvidence);

/**
 * Every number the summary asserts that the quote does not actually contain.
 *
 * Three traps this avoids:
 *  - substring matching. "12%" is not supported by a quote saying "1,204
 *    users", even though "1204".includes("12"). Matching is token-wise.
 *  - single digits. "3 of 5 trials" is a finding; the old two-digit floor
 *    waved it through. Digits inside words (COVID-19, GPT-4, S001) are
 *    excluded instead, which is the case the floor was really guarding.
 *  - unit drift. A quote of "0.87" does not license a summary of "87%", so
 *    percent signs are compared as their own token.
 */
function numbersMissingFrom(summary: string, quote: string): string[] {
  const qTokens = new Set(numbersIn(quote));
  // A bare number in the quote also supports a bare number in the summary,
  // and "45%" in the quote supports a summary saying "45". The reverse is not
  // true: a bare 0.87 does not support "87%".
  const qBare = new Set([...qTokens].map((t) => t.replace(/%$/, "")));

  const missing: string[] = [];
  for (const t of numbersIn(summary)) {
    if (qTokens.has(t)) continue;
    if (!t.endsWith("%") && qBare.has(t)) continue;
    missing.push(t);
  }
  return [...new Set(missing)];
}

/** The figure tokens a piece of prose asserts, normalised, `%` kept as part of the token. */
function numbersIn(s: string): string[] {
  // Strip citation ids and ledger ids first — [S001] is not a claim about 1.
  const clean = s
    .replace(/\[(?:S|E|CL|V|C)\d+\]/gi, " ")
    .replace(/\b(?:table|figure|fig|section|§|p|pp|chapter|ref)\.?\s*\d+(?:\.\d+)*/gi, " ")
    .replace(/,(?=\d{3}\b)/g, "")   // thousands separators only
    .replace(/\s*(?:percent|per cent|pct\.?)/gi, "%")
    .toLowerCase();
  const outp: string[] = [];
  for (const m of clean.matchAll(/(?<![\p{L}\d._-])(\d+(?:\.\d+)?)\s*(%)?/gu)) {
    outp.push(m[2] ? `${m[1]}%` : m[1]);
  }
  return outp;
}

function applyExtract(l: Ledger, o: Record<string, any>): Applied {
  const source = need(o, "source");
  if (!l.sources.some((s) => s.id === source)) throw new Error(`unknown source ${source}`);
  const column = need(o, "col");
  const value = need(o, "value");
  const quote = str(o.quote) ?? null;
  const existing = l.extraction.find((e) => e.source === source && e.column === column);
  const rec: Extract = { source, column, value, quote, locator: str(o.locator) ?? null, at: now() };
  if (existing) Object.assign(existing, rec);
  else l.extraction.push(rec);
  const warns: string[] = [];
  if (!quote && !/^(not reported|n\/a|none)$/i.test(value) && !value.startsWith("inferred:")) {
    warns.push(`no quote for ${source}.${column} — a cell without a quote is an inference; mark it "inferred: …" or add the quote`);
  }
  return { line: `${source}.${column} = ${value}`, warns };
}

const cmdExtract = (o: Record<string, any>) => runCmd("extract", o, applyExtract);

function applyClaim(l: Ledger, o: Record<string, any>): Applied {
  const id = str(o.id) ?? nextId("CL", l.claims.map((c) => c.id));
  const consensus = need(o, "consensus");
  if (!CONSENSUS.includes(consensus)) throw new Error(`--consensus must be one of: ${CONSENSUS.join(", ")}`);
  const evidence = (str(o.evidence) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const e of evidence) if (!l.evidence.some((x) => x.id === e)) throw new Error(`unknown evidence id ${e}`);
  const existing = l.claims.find((c) => c.id === id);
  const rec: Claim = { id, text: need(o, "text"), evidence, consensus, at: now() };
  if (existing) Object.assign(existing, rec);
  else l.claims.push(rec);

  const warns: string[] = [];
  const recs = l.evidence.filter((e) => evidence.includes(e.id));
  const sources = new Set(recs.map((e) => e.source));
  if (consensus === "strong" && sources.size < 3) {
    warns.push(`"strong" needs 3+ independent sources; this has ${sources.size}. Check authors, affiliations, and datasets before keeping this label`);
  }
  if (consensus !== "thin" && sources.size === 1) warns.push(`only one source supports this — "thin" is the honest label`);
  if (!evidence.length) warns.push("no evidence attached — this claim cannot appear in the report");
  return { line: `${id}: ${consensus}, ${evidence.length} evidence record(s)`, warns };
}

const cmdClaim = (o: Record<string, any>) => runCmd("claim", o, applyClaim);

async function cmdContradiction(o: Record<string, any>) {
  const dir = need(o, "dir");
  const l = await load(dir);
  const a = need(o, "a"), b = need(o, "b");
  for (const e of [a, b]) if (!l.evidence.some((x) => x.id === e)) throw new Error(`unknown evidence id ${e}`);
  const klass = need(o, "class");
  if (!CONTRADICTION_CLASSES.includes(klass)) throw new Error(`--class must be one of: ${CONTRADICTION_CLASSES.join(", ")}`);
  l.contradictions.push({ a, b, class: klass, note: str(o.note) ?? null, at: now() });
  await save(dir, l);
  out(`contradiction ${a} vs ${b}: ${klass}`);
  warn("this must appear in the report — never average the two sides into one number");
}

/**
 * Stage 5 (CoVe). One record per verification question asked of one claim.
 * `unsupported` and `contradicted` are hard blockers in `audit` — a claim that
 * fails verification must be rewritten, downgraded, or deleted, not shipped.
 */
function applyVerify(l: Ledger, o: Record<string, any>): Applied {
  const claim = need(o, "claim");
  if (!l.claims.some((c) => c.id === claim)) throw new Error(`unknown claim id ${claim}`);
  const status = need(o, "status");
  if (!VERIFY_STATUS.includes(status)) throw new Error(`--status must be one of: ${VERIFY_STATUS.join(", ")}`);
  const evidence = (str(o.evidence) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const e of evidence) if (!l.evidence.some((x) => x.id === e)) throw new Error(`unknown evidence id ${e}`);
  const id = nextId("V", l.verification.map((v) => v.id));
  l.verification.push({
    id, claim, question: need(o, "question"), answer: need(o, "answer"),
    status: status as Verification["status"], evidence, note: str(o.note) ?? null, at: now(),
  });
  const warns: string[] = [];
  if (status === "unsupported") warns.push("the evidence does not support this claim — remove it or write the gap in gaps.md (non-negotiable 3)");
  if (status === "contradicted") warns.push("record the contradiction with 'contradiction' and show both sides in the report — never average them");
  if (status !== "supported" && !evidence.length) warns.push("no evidence attached to a failing verification — the reader cannot check your reasoning");
  return { line: `${id}: ${claim} -> ${status}`, warns };
}

const cmdVerify = (o: Record<string, any>) => runCmd("verify", o, applyVerify);

async function cmdLogQuery(o: Record<string, any>) {
  const dir = need(o, "dir");
  const l = await load(dir);
  const lang = str(o.lang) ?? null;
  if (lang !== null && !isValidLangTag(lang)) {
    throw new Error(`--lang must be an ISO 639 code, optionally with a region, or "auto": vi, de, ja, ru`);
  }
  l.queries.push({
    q: need(o, "q"), source: str(o.source) ?? "web",
    hits: o.hits !== undefined ? Number(o.hits) : null,
    kept: o.kept !== undefined ? Number(o.kept) : null, lang, at: now(),
  });
  await save(dir, l);
  out(`logged: ${need(o, "q")} (${str(o.source) ?? "web"}, ${o.hits ?? "?"} hits${lang ? `, ${lang}` : ""})`);
}

// ------------------------------------------------------------------ stats

function computeStats(l: Ledger) {
  const p1 = verdictsFor(l, "pass1");
  const p2 = verdictsFor(l, "pass2");
  // Tally reasons from the latest verdict per source, not from every screening
  // event. A re-screened source would otherwise be counted twice and the
  // published exclusion counts would not add up to the funnel.
  const byReason: Record<string, number> = {};
  for (const s of p1.values()) {
    if (s.verdict === "exclude" && s.reason) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
  }
  const included = [...p1.values()].filter((s) => s.verdict === "include").length;
  const excluded = [...p1.values()].filter((s) => s.verdict === "exclude").length;

  const conflicts: { source: string; pass1: string; pass2: string }[] = [];
  let compared = 0;
  for (const [src, v2] of p2) {
    const v1 = p1.get(src);
    if (!v1) continue;
    compared++;
    if (v1.verdict !== v2.verdict) conflicts.push({ source: src, pass1: v1.verdict, pass2: v2.verdict });
  }

  const byKind: Record<string, number> = {};
  const byYear: Record<string, number> = {};
  const byInterest: Record<string, number> = {};
  for (const s of l.sources) {
    byKind[s.kind ?? "unknown"] = (byKind[s.kind ?? "unknown"] ?? 0) + 1;
    byYear[String(s.year ?? "unknown")] = (byYear[String(s.year ?? "unknown")] ?? 0) + 1;
    const i = s.interest_disclosure ?? "unclear";
    byInterest[i] = (byInterest[i] ?? 0) + 1;
  }

  return {
    topic: l.topic, mode: l.mode, created: l.created, updated: l.updated,
    criteria: l.criteria.length,
    queries_logged: l.queries.length,
    funnel: {
      identified: l.sources.length,
      metadata_only: l.sources.filter((s) => s.metadata_at && !s.read_at).length,
      read: l.sources.filter((s) => s.read_at).length,
      read_fulltext: l.sources.filter((s) => s.read_at && s.read_scope !== "abstract").length,
      unfetched: l.sources.filter((s) => !s.metadata_at).length,
      screened: p1.size,
      unscreened: l.sources.length - p1.size,
      excluded,
      included,
    },
    exclusions_by_reason: byReason,
    dual_review: {
      double_screened: compared,
      conflicts: conflicts.length,
      agreement_pct: compared ? Math.round(((compared - conflicts.length) / compared) * 100) : null,
      conflict_list: conflicts,
    },
    sources_by_kind: byKind,
    sources_by_year: Object.fromEntries(Object.entries(byYear).sort((a, b) => b[0].localeCompare(a[0]))),
    sources_by_interest: byInterest,
    sources_with_anomalies: l.sources.filter((s) => (s.anomalies ?? []).length).map((s) => s.id),
    evidence: {
      total: l.evidence.length,
      citable_7plus: l.evidence.filter((e) => e.score >= CITE_THRESHOLD).length,
      context_6: l.evidence.filter((e) => e.score === KEEP_THRESHOLD).length,
      below_threshold: l.evidence.filter((e) => e.score < KEEP_THRESHOLD).length,
      with_quote: l.evidence.filter((e) => e.quote).length,
      questions_covered: [...new Set(l.evidence.map((e) => e.question))].length,
    },
    extraction: {
      cells: l.extraction.length,
      columns: [...new Set(l.extraction.map((e) => e.column))].length,
      cells_with_quote: l.extraction.filter((e) => e.quote).length,
      not_reported: l.extraction.filter((e) => /^not reported$/i.test(e.value)).length,
    },
    claims: {
      total: l.claims.length,
      by_consensus: Object.fromEntries(CONSENSUS.map((c) => [c, l.claims.filter((x) => x.consensus === c).length])),
    },
    contradictions: {
      total: l.contradictions.length,
      by_class: Object.fromEntries(CONTRADICTION_CLASSES.map((c) => [c, l.contradictions.filter((x) => x.class === c).length])),
    },
    verification: {
      questions: l.verification.length,
      claims_verified: [...new Set(l.verification.map((v) => v.claim))].length,
      claims_unverified: l.claims.filter((c) => !l.verification.some((v) => v.claim === c.id)).length,
      by_status: Object.fromEntries(VERIFY_STATUS.map((s) => [s, l.verification.filter((v) => v.status === s).length])),
    },
  };
}

/**
 * The counting rule, made checkable.
 *
 * Telling an agent "every number comes from stats" is a convention, and a
 * convention drifts: the report says 42 screened, the ledger says 38, and
 * nothing notices. This emits the funnel inside markers with a machine-readable
 * payload, so `audit --report` can re-derive the same numbers and fail on a
 * mismatch. Paste the block into REPORT.md (or 08-audit.md) as-is.
 */
const STATS_OPEN = "<!-- drp:stats v1";
const STATS_CLOSE = "<!-- /drp:stats -->";

/**
 * Two report checks used to be able to read only English and Vietnamese: the
 * "Evidence current as of" line and the start of the reference list. That made
 * `--output-lang` effectively a two-language flag — a report written in
 * Japanese failed an audit rule it had actually satisfied. These markers are
 * the language-neutral way to say the same thing; the natural-language phrases
 * still work where the language is one the audit knows.
 */
const AS_OF_MARKER = "<!-- drp:as-of";
const REFS_MARKER = "<!-- drp:references -->";
/** Phrases that mean "evidence current as of" in the languages audit reads. */
const AS_OF_PHRASES = /evidence current as of|bằng chứng cập nhật đến/i;
/** Reference-list headings in the languages audit reads. */
const REFS_HEADING = /^##+\s*(?:references|tài liệu tham khảo|bibliography)\b.*$/im;

/** The counts the block asserts. Keep flat: every value is compared literally. */
function statsPayload(s: ReturnType<typeof computeStats>) {
  return {
    identified: s.funnel.identified,
    read: s.funnel.read,
    read_fulltext: s.funnel.read_fulltext,
    screened: s.funnel.screened,
    excluded: s.funnel.excluded,
    included: s.funnel.included,
    evidence: s.evidence.total,
    evidence_citable: s.evidence.citable_7plus,
    claims: s.claims.total,
    contradictions: s.contradictions.total,
    verification: s.verification.questions,
  };
}

function statsBlock(s: ReturnType<typeof computeStats>): string[] {
  const p = statsPayload(s);
  return [
    `${STATS_OPEN} ${JSON.stringify(p)} -->`,
    `| Step | Count |`,
    `|------|-------|`,
    `| Sources identified | ${p.identified} |`,
    `| Read (citable) | ${p.read} — ${p.read_fulltext} full text |`,
    `| Screened | ${p.screened} |`,
    `| Excluded | ${p.excluded} |`,
    `| **Included** | **${p.included}** |`,
    `| Evidence records | ${p.evidence} — ${p.evidence_citable} at the cite threshold |`,
    `| Claims | ${p.claims} |`,
    `| Contradictions recorded | ${p.contradictions} |`,
    `| Verification questions | ${p.verification} |`,
    ``,
    `_Counts generated by \`ledger.ts stats --md\`; \`audit --report\` re-derives them and fails on a mismatch._`,
    STATS_CLOSE,
  ];
}

async function cmdStats(o: Record<string, any>) {
  const l = await load(need(o, "dir"));
  const s = computeStats(l);
  if (o.json) { out(JSON.stringify(s, null, 2)); return; }
  if (o.md) {
    for (const line of statsBlock(s)) out(line);
    warn("paste this block into the deliverable unedited — audit --report recomputes it and errors if a number was changed");
    return;
  }

  const f = s.funnel;
  out(`# Ledger stats — ${s.topic || "(untitled)"}`);
  out(`mode ${s.mode} · updated ${s.updated.slice(0, 16).replace("T", " ")} · ${s.criteria} criteria · ${s.queries_logged} queries logged\n`);
  out(`## Funnel`);
  out(`| Step | Count |`);
  out(`|------|-------|`);
  out(`| Identified | ${f.identified} |`);
  out(`| Read — citable | ${f.read} (${f.read_fulltext} full text) |`);
  out(`| Metadata only — NOT citable | ${f.metadata_only} |`);
  out(`| No metadata at all | ${f.unfetched} |`);
  out(`| Screened | ${f.screened} |`);
  out(`| Awaiting screening | ${f.unscreened} |`);
  out(`| Excluded | ${f.excluded} |`);
  out(`| **Included** | **${f.included}** |`);
  if (Object.keys(s.exclusions_by_reason).length) {
    out(`\n## Exclusions by reason`);
    out(Object.entries(s.exclusions_by_reason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "));
  }
  const d = s.dual_review;
  if (d.double_screened) {
    out(`\n## Dual review`);
    out(`${d.agreement_pct}% agreement (${d.double_screened - d.conflicts}/${d.double_screened}), ${d.conflicts} conflict(s)`);
    for (const c of d.conflict_list) out(`  ${c.source}: pass1 ${c.pass1} vs pass2 ${c.pass2}`);
    if (d.agreement_pct !== null && d.agreement_pct < 80) out(`  agreement below 80% — the criteria are underspecified; sharpen them with the user and rescreen`);
  }
  out(`\n## Sources`);
  out(`by kind: ${Object.entries(s.sources_by_kind).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
  out(`by interest: ${Object.entries(s.sources_by_interest).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
  out(`by year: ${Object.entries(s.sources_by_year).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
  if (s.sources_with_anomalies.length) out(`metadata anomalies: ${s.sources_with_anomalies.join(", ")}`);
  const e = s.evidence;
  out(`\n## Evidence`);
  out(`${e.total} records · ${e.citable_7plus} citable (7+) · ${e.context_6} context-only (6) · ${e.below_threshold} below threshold · ${e.with_quote} with a quote · ${e.questions_covered} question(s) covered`);
  out(`\n## Extraction`);
  out(`${s.extraction.cells} cells across ${s.extraction.columns} columns · ${s.extraction.cells_with_quote} with a quote · ${s.extraction.not_reported} "not reported"`);
  out(`\n## Claims`);
  out(`${s.claims.total} total — ${Object.entries(s.claims.by_consensus).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
  out(`\n## Contradictions`);
  out(`${s.contradictions.total} total — ${Object.entries(s.contradictions.by_class).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
  const v = s.verification;
  out(`\n## Verification (CoVe)`);
  out(`${v.questions} question(s) over ${v.claims_verified} claim(s) · ${v.claims_unverified} claim(s) not yet verified — ${Object.entries(v.by_status).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ") || "none"}`);
}

/**
 * Author names two or more of these sources have in common, normalised to
 * "surname, first-initial" so "Jane Q. Smith" and "Smith, J." collide.
 * Deliberately generous: a false alarm costs one glance, a missed overlap
 * costs a fabricated consensus.
 */
function sharedAuthors(sources: Source[]): string[] {
  const key = (raw: string): string | null => {
    const n = String(raw).trim().replace(/\s+/g, " ");
    if (n.length < 3) return null;
    let surname: string, rest: string;
    if (n.includes(",")) {
      const [a, b = ""] = n.split(",");
      surname = a; rest = b;
    } else {
      const parts = n.split(" ");
      surname = parts.pop()!; rest = parts.join(" ");
    }
    surname = surname.toLowerCase().replace(/[^\p{L}-]/gu, "");
    const initial = (rest.match(/\p{L}/u)?.[0] ?? "").toLowerCase();
    return surname.length < 2 ? null : `${surname},${initial}`;
  };

  const seen = new Map<string, { label: string; ids: Set<string> }>();
  for (const s of sources) {
    const authors: string[] = Array.isArray(s.authors) ? s.authors : [];
    for (const k of new Set(authors.map(key).filter(Boolean) as string[])) {
      const hit = seen.get(k) ?? { label: authors.find((a) => key(a) === k) ?? k, ids: new Set<string>() };
      hit.ids.add(s.id);
      seen.set(k, hit);
    }
  }
  return [...seen.values()]
    .filter((v) => v.ids.size >= 2)
    .map((v) => `${v.label} in ${[...v.ids].sort().join("+")}`);
}

// ------------------------------------------------------------------ audit

// ---------------------------------------------------------- the contract

/**
 * The tooling contract, generated from the code that enforces it.
 *
 * Vocabularies, thresholds, filenames and exit codes used to be typed out by
 * hand in `references/ledger.md` and restated in half the stage files, which
 * is why those files carry lines like "this table wins" and "an older note
 * using report.md is a legacy label" — symptoms of prose drifting away from
 * the checks. `contract --md` prints the whole thing between markers;
 * `contract --check F` fails when the copy embedded in a file no longer
 * matches. Docs cannot drift from the code they describe if the code writes
 * that part of the docs.
 */
const CONTRACT_OPEN = "<!-- drp:contract v1 -->";
const CONTRACT_CLOSE = "<!-- /drp:contract -->";

function contractBlock(): string[] {
  const table = (head: string[], rows: string[][]) => [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
  return [
    CONTRACT_OPEN,
    `_Generated by \`ledger.ts contract --md\` from the constants the checks read._`,
    ``,
    `### Closed vocabularies`,
    ``,
    ...table(["Field", "Allowed values"], [
      ["criterion `--id`", "`C1`, `C2`, … — yours to assign, one series for both directions"],
      ["criterion `--direction`", "`include`, `exclude`"],
      ["criterion / screen `--stage`", "`metadata`, `abstract`, `fulltext`"],
      ["screen `--verdict`", "`include`, `exclude`, `defer`"],
      ["screen `--reason` (mandatory on exclude)", EXCLUSION_REASONS.map((v) => `\`${v}\``).join(", ")],
      ["screen `--reviewer`", "`pass1`, `pass2`, `human`"],
      ["evidence `--score`", `integer ${1}–${10}`],
      ["claim `--consensus`", CONSENSUS.map((v) => `\`${v}\``).join(", ")],
      ["contradiction `--class`", CONTRADICTION_CLASSES.map((v) => `\`${v}\``).join(", ")],
      ["verify `--status`", VERIFY_STATUS.map((v) => `\`${v}\``).join(", ")],
      ["memory `--kind`", "`preference`, `scope`, `source`, `method`, `pitfall`, `terminology`"],
      ["mark-read `--scope`", "`abstract`, `fulltext`"],
      ["`init --mode`", MODES.map((v) => `\`${v}\``).join(", ")],
      ["`init --lang`", "any ISO 639 code, optionally with a region (`en`, `vi`, `ja`, `pt-BR`)"],
      ["`init --query-lang`", "`auto`, or a comma-separated list of ISO 639 codes (`vi,de,ja,ru`) — separate from `--lang`, which is the deliverable language"],
      ["`log-query --lang`", "any ISO 639 code, optionally with a region, or `auto`"],
      ["`gate --pass`", GATES.map((v) => `\`${v}\``).join(", ")],
    ]),
    ``,
    `**Ids.** Scripts assign \`S###\` sources, \`E###\` evidence, \`CL###\` claims,`,
    `\`V###\` verification. You assign \`C#\` criteria. Report body text cites`,
    `\`[S007]\`. No other pattern is a real id — not \`IC-01\`, \`CLM-001\`, \`EV###\`,`,
    `\`ev_001\`, \`src_001\`, \`FND-###\`, \`RQ-##\`. Translate one if you meet it in an`,
    `older note. Relevance is one integer 1–10 per evidence record: no quality`,
    `float, no source tier, no confidence percentage.`,
    ``,
    `### Thresholds the scripts enforce`,
    ``,
    ...table(["Rule", "Value", "Where", "Severity"], THRESHOLDS.map((t) => [...t])),
    ``,
    `### Run directory`,
    ``,
    `Filenames are exact and case-sensitive.`,
    ``,
    ...table(["File", "Holds"], RUN_FILE_NOTES.map(([f, note]) => [`\`${f}\``, note])),
    ``,
    `### Exit codes`,
    ``,
    ...table(["Code", "Meaning"], [
      ["0", "ok"],
      ["1", "error, or audit findings"],
      ["2", "**refused by design** — the rule is not a bug to retry around"],
      ["3", "`scholar.ts fetch` found no full text (a fact about the source, not a failure)"],
    ]),
    ``,
    `### Environment`,
    ``,
    ...table(["Variable", "Effect"], [
      ["`DRP_RUN_DIR`", "default for `--dir` — set it once per run"],
      ["`DRP_CACHE_DIR`", "relocate the shared cross-run source cache"],
      ["`OPENALEX_API_KEY`", "10× daily budget, usage tracking"],
      ["`SEMANTIC_SCHOLAR_API_KEY`", "strongly recommended; the keyless tier returns 429 under real load"],
      ["`RESEARCH_CONTACT`", "an email, sent to Crossref and Unpaywall as etiquette; required for `fetch`'s Unpaywall route"],
    ]),
    ``,
    `### Language-neutral markers`,
    ``,
    `\`audit --report\` reads English and Vietnamese headings natively. In any`,
    `other output language, mark the two places it looks for:`,
    ``,
    "```markdown",
    `${AS_OF_MARKER} 2026-09-03 -->     <!-- the currency line -->`,
    `${REFS_MARKER}                     <!-- start of the reference list -->`,
    "```",
    CONTRACT_CLOSE,
  ];
}

async function cmdContract(o: Record<string, any>) {
  const block = contractBlock();
  const target = str(o.check);
  if (!target) { for (const line of block) out(line); return; }

  const f = Bun.file(target);
  if (!(await f.exists())) throw new Error(`--check ${target} does not exist`);
  const body = await f.text();
  const openAt = body.indexOf(CONTRACT_OPEN);
  const closeAt = body.indexOf(CONTRACT_CLOSE, openAt + 1);
  if (openAt === -1 || closeAt === -1) {
    out(`${target} carries no ${CONTRACT_OPEN} … ${CONTRACT_CLOSE} block — paste 'ledger.ts contract --md' output into it`);
    process.exitCode = 1;
    return;
  }
  const embedded = body.slice(openAt, closeAt + CONTRACT_CLOSE.length).replace(/\r\n/g, "\n").trim();
  if (embedded === block.join("\n").trim()) { out(`${target} is in sync with the scripts`); return; }
  out(`${target} is STALE — the embedded contract no longer matches the scripts.`);
  out(`Regenerate it: bun ledger.ts contract --md  (replace everything between the markers)`);
  process.exitCode = 1;
}

async function cmdAudit(o: Record<string, any>) {
  const dir = need(o, "dir");
  const l = await load(dir);
  type Finding = { severity: "error" | "warn"; check: string; detail: string };
  const found: Finding[] = [];
  const err = (check: string, detail: string) => found.push({ severity: "error", check, detail });
  const wrn = (check: string, detail: string) => found.push({ severity: "warn", check, detail });

  const evById = new Map(l.evidence.map((e) => [e.id, e]));
  const srcById = new Map(l.sources.map((s) => [s.id, s]));
  const included = new Set(includedSources(l).map((s) => s.id));

  for (const c of l.claims) {
    if (!c.evidence.length) err("claim-without-evidence", `${c.id} has no evidence and cannot appear in the report`);
    const cited = c.evidence.map((id) => evById.get(id)).filter(Boolean) as Evidence[];
    const weak = cited.filter((e) => e.score < CITE_THRESHOLD);
    if (weak.length) wrn("claim-on-weak-evidence", `${c.id} rests partly on sub-${CITE_THRESHOLD} evidence: ${weak.map((e) => `${e.id}(${e.score})`).join(", ")}`);
    const srcs = new Set(cited.map((e) => e.source));
    if (c.consensus === "strong" && srcs.size < 3) err("overstated-consensus", `${c.id} is labelled strong but rests on ${srcs.size} source(s)`);
    else if (srcs.size === 1 && !["thin", "absent"].includes(c.consensus)) err("overstated-consensus", `${c.id} rests on one source but is labelled ${c.consensus}`);
    // P3a — the independence pre-check the manual list used to leave to the
    // eye. Three papers by the same group are one source of evidence wearing
    // three hats; the tool cannot settle it, but it can refuse to be quiet.
    if (["strong", "moderate"].includes(c.consensus) && srcs.size >= 2) {
      const overlap = sharedAuthors([...srcs].map((id) => srcById.get(id)).filter(Boolean) as Source[]);
      if (overlap.length) {
        wrn("possible-shared-authorship", `${c.id} is labelled ${c.consensus} but its sources share author(s): ${overlap.slice(0, 4).join("; ")} — confirm the sources are independent or downgrade the label`);
      }
      const venues = [...srcs].map((id) => srcById.get(id)?.venue).filter(Boolean);
      if (venues.length >= 3 && new Set(venues).size === 1) {
        wrn("single-venue-consensus", `${c.id} draws every source from "${venues[0]}" — that is one editorial filter, not a consensus`);
      }
    }
    for (const e of cited) {
      const s = srcById.get(e.source);
      if (s && !s.read_at) err("cited-but-unread", `${c.id} -> ${e.id} -> ${e.source} has no read_at — metadata is not a reading (run mark-read)`);
      if (s && !included.has(e.source)) wrn("cited-but-not-included", `${c.id} -> ${e.id} -> ${e.source} is cited but not marked included`);
    }
  }

  for (const e of l.evidence) {
    if (!srcById.has(e.source)) err("orphan-evidence", `${e.id} points at unknown source ${e.source}`);
    if (!e.quote) wrn("evidence-without-quote", `${e.id} has no quote — its numbers are unverifiable`);
    else {
      for (const n of numbersMissingFrom(e.summary, e.quote)) {
        err("number-not-in-quote", `${e.id} asserts "${n}" but the quote does not contain it`);
      }
    }
    if (!e.locator && e.score >= CITE_THRESHOLD) wrn("no-locator", `${e.id} is citable but has no locator`);
    if (e.score >= CITE_THRESHOLD && !e.scope_note) wrn("no-scope-note", `${e.id} is citable but records no scope conditions`);
    // Non-negotiable 1 at figure level. An abstract states results without the
    // method, the population, or the caveat, so a number lifted from one is
    // the single easiest way for a well-cited report to still be wrong.
    // `from_scope` is stamped at add time; fall back to the source for records
    // written before it existed.
    const scope = e.from_scope ?? (srcById.get(e.source)?.read_scope === "abstract" ? "abstract" : "fulltext");
    if (scope === "abstract" && numbersIn(e.summary).length && l.claims.some((c) => c.evidence.includes(e.id))) {
      const sev = l.mode === "quick" ? wrn : err;
      sev("figure-from-abstract", `${e.id} backs a claim with a number taken from ${e.source}'s abstract — read the full text (scholar.ts fetch) or drop the figure`);
    }
  }

  for (const s of l.sources) {
    if ((s.anomalies ?? []).length) {
      const sev = included.has(s.id) ? err : wrn;
      sev("suspect-metadata", `${s.id} [${s.anomalies.join(", ")}] — verify against the publisher page: ${String(s.title).slice(0, 60)}`);
    }
    if (s.retracted === true && included.has(s.id)) err("retracted-included", `${s.id} is retracted but marked included`);
    if (included.has(s.id) && !l.evidence.some((e) => e.source === s.id)) {
      wrn("included-but-unused", `${s.id} passed screening but produced no evidence records`);
    }
    if (included.has(s.id) && !s.metadata_at) err("included-but-unfetched", `${s.id} is included but has no metadata date at all`);
    if (included.has(s.id) && !s.read_at) {
      err("included-but-unread", `${s.id} is included but was never read — metadata arrived, nobody opened it (run mark-read, or exclude it as unobtainable)`);
    } else if (included.has(s.id) && !(await Bun.file(cacheFile(dir, s.id)).exists())) {
      // read_at without the cache file means the file was deleted after the
      // fact. The quote is no longer checkable, which is the whole point.
      err("cache-missing", `${s.id} is marked read but ${cacheFile(dir, s.id)} is gone — its quotes are no longer checkable`);
    }
    if (included.has(s.id) && s.read_scope === "abstract" && l.mode === "systematic") {
      wrn("abstract-only-in-systematic", `${s.id} is abstract-only; systematic mode requires full text for included sources`);
    }
  }

  const cols = [...new Set(l.extraction.map((e) => e.column))];
  if (cols.length) {
    for (const sid of included) {
      const missing = cols.filter((c) => !l.extraction.some((e) => e.source === sid && e.column === c));
      if (missing.length) wrn("matrix-hole", `${sid} has no value for: ${missing.join(", ")}`);
    }
  }
  for (const e of l.extraction) {
    if (!e.quote && !/^(not reported|n\/a|none)$/i.test(e.value) && !e.value.startsWith("inferred:")) {
      wrn("cell-without-quote", `${e.source}.${e.column} = "${e.value}" has no quote and is not marked inferred`);
    }
  }

  for (const c of l.contradictions) {
    for (const side of [c.a, c.b]) if (!evById.has(side)) err("orphan-contradiction", `contradiction references unknown evidence ${side}`);
  }

  const questions = [...new Set(l.evidence.map((e) => e.question))];
  for (const q of questions) {
    const best = Math.max(...l.evidence.filter((e) => e.question === q).map((e) => e.score));
    if (best < CITE_THRESHOLD) wrn("question-thin", `${q} has no evidence at ${CITE_THRESHOLD}+ — apply the refusal rule rather than writing a weak answer`);
  }

  if (!l.criteria.length) wrn("no-criteria", "no criteria registered — screening decisions are not reviewable");
  if (!l.queries.length) wrn("no-search-log", "no queries logged — coverage cannot be reviewed (use log-query)");

  // ---- The gates. `gate --pass` recorded them and `state` reported them, but
  // nothing ever checked them, so a run could sail past every handover to the
  // user and still audit clean — the one place this pipeline asked to be
  // trusted rather than checked. A gate is a conversation, so the tool can
  // only notice that it never happened; in `systematic` mode, where the
  // protocol is the deliverable, an unrecorded handover is a defect.
  const passedGates = new Set((l.gates ?? []).map((g) => g.gate));
  const gateSev = l.mode === "systematic" ? err : wrn;
  if (l.evidence.length && !passedGates.has("scope")) {
    gateSev("gate-skipped", "evidence was collected but the scope gate was never recorded — criteria and framing went unreviewed (ledger.ts gate --pass scope)");
  }

  // Stage 5 — CoVe. A claim that failed verification must not reach the report.
  const claimIds = new Set(l.claims.map((c) => c.id));
  for (const v of l.verification) {
    if (!claimIds.has(v.claim)) err("orphan-verification", `${v.id} points at unknown claim ${v.claim}`);
    for (const e of v.evidence) if (!evById.has(e)) err("orphan-verification", `${v.id} cites unknown evidence ${e}`);
    if (v.status === "unsupported") err("claim-failed-verification", `${v.claim} (${v.id}) is unsupported: ${v.question}`);
    if (v.status === "contradicted") {
      const covered = l.contradictions.some((c) => v.evidence.includes(c.a) || v.evidence.includes(c.b));
      if (!covered) err("contradiction-not-recorded", `${v.claim} (${v.id}) verified as contradicted but no contradiction record exists`);
    }
  }
  if (l.verification.length) {
    for (const c of l.claims) {
      if (!l.verification.some((v) => v.claim === c.id)) wrn("claim-unverified", `${c.id} has no verification question — stage 5 is incomplete for it`);
    }
  }

  // ---- Access bias. Everything above asks whether the evidence is sound;
  // this asks what the evidence base is missing by construction. A corpus
  // built from what happened to be free is not a corpus of what is known, and
  // the funnel is the only place that shows it. Warnings, not errors: the fix
  // is disclosure, not a different literature.
  const st = computeStats(l);
  const unobtainable = st.exclusions_by_reason["unobtainable"] ?? 0;
  if (unobtainable >= 3 && st.funnel.screened > 0 && unobtainable / st.funnel.screened >= 0.15) {
    wrn("access-bias-unobtainable",
      `${unobtainable} of ${st.funnel.screened} screened source(s) (${Math.round((unobtainable / st.funnel.screened) * 100)}%) were excluded as unobtainable — the evidence base is skewed toward what is free to read. Say so in the report and put the paywalled leads in gaps.md`);
  }
  const inc = includedSources(l);
  const abstractOnly = inc.filter((s) => s.read_scope === "abstract").length;
  if (inc.length >= 2 && abstractOnly / inc.length >= 0.5) {
    wrn("access-bias-abstract-only",
      `${abstractOnly} of ${inc.length} included source(s) were read as abstracts only (${Math.round((abstractOnly / inc.length) * 100)}%) — no figure may rest on them (non-negotiable 13). 'scholar.ts fetch' resolves full text where an OA copy exists; where it does not, disclose the limit`);
  }

  // ---- Stage 6. graph.json is written directly rather than through a ledger
  // command, which left it as the one artefact whose ids nobody checked — a
  // fabricated [S###] could sit in a node forever. Structure is validated too:
  // an edge to a node that does not exist is a graph that was never built.
  const graphArg = o["no-graph"] ? null : (str(o.graph) ?? `${dir.replace(/[\\/]+$/, "")}/graph.json`);
  if (graphArg && await Bun.file(graphArg).exists()) {
    let g: any = null;
    try { g = JSON.parse(await Bun.file(graphArg).text()); }
    catch (e) { err("graph-unparseable", `${graphArg} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`); }
    if (g) {
      const nodes: any[] = Array.isArray(g.nodes) ? g.nodes : [];
      const edges: any[] = Array.isArray(g.edges) ? g.edges : [];
      if (!nodes.length) err("graph-empty", `${graphArg} holds no nodes — delete it or build the graph (stage 6)`);
      const nodeIds = new Set(nodes.map((n) => String(n?.id ?? "")).filter(Boolean));
      const knownLedgerIds = new Set<string>([
        ...l.sources.map((s) => s.id), ...l.evidence.map((e) => e.id),
        ...l.claims.map((c) => c.id), ...l.verification.map((v) => v.id),
      ]);

      const checkIds = (raw: unknown, what: string) => {
        const ids = Array.isArray(raw) ? raw.map((x) => String(x).toUpperCase().replace(/[[\]]/g, "")) : [];
        if (!ids.length) {
          wrn("graph-without-ledger-id", `${what} carries no ledger_ids — every node and edge traces to the ledger or it is not evidence-backed`);
          return;
        }
        for (const id of ids) {
          if (!/^(S|E|CL|V)\d+$/.test(id)) { err("graph-bad-id", `${what} lists "${id}", which is not a ledger id (S###, E###, CL###, V###)`); continue; }
          if (!knownLedgerIds.has(id)) { err("graph-unknown-id", `${what} lists ${id}, which is not in the ledger — a fabricated id`); continue; }
          if (id.startsWith("S")) {
            if (!included.has(id)) err("graph-excluded-source", `${what} lists ${id}, which did not pass screening`);
            else if (!srcById.get(id)?.read_at) err("graph-unread-source", `${what} lists ${id}, which was never read`);
          }
        }
      };

      for (const n of nodes) {
        const label = `graph node ${n?.id ?? "(no id)"}`;
        if (!n?.id) err("graph-node-without-id", `a node in ${graphArg} has no id — edges cannot reference it`);
        checkIds(n?.ledger_ids, label);
      }
      for (const e of edges) {
        const label = `graph edge ${e?.source ?? "?"} -> ${e?.target ?? "?"}`;
        for (const side of ["source", "target"]) {
          const v = e?.[side];
          if (!v) err("graph-edge-endpoint-missing", `${label} has no ${side}`);
          else if (!nodeIds.has(String(v))) err("graph-dangling-edge", `${label} points at "${v}", which is not a node in ${graphArg}`);
        }
        checkIds(e?.ledger_ids, label);
      }
      const declared = g.metadata ?? {};
      if (Number.isFinite(declared.node_count) && declared.node_count !== nodes.length) {
        wrn("graph-count-mismatch", `${graphArg} metadata says ${declared.node_count} nodes but holds ${nodes.length}`);
      }
      if (Number.isFinite(declared.edge_count) && declared.edge_count !== edges.length) {
        wrn("graph-count-mismatch", `${graphArg} metadata says ${declared.edge_count} edges but holds ${edges.length}`);
      }
    }
  }


  // Everything above checks the ledger against itself. None of it can tell
  // whether the deliverable actually cites what the ledger holds, which is
  // where a citation quietly goes missing. Opt in with --report.
  const reportArg = o.report === true ? `${dir.replace(/[\\/]+$/, "")}/REPORT.md` : str(o.report);
  if (reportArg) {
    const rf = Bun.file(reportArg);
    if (!(await rf.exists())) {
      err("report-missing", `--report ${reportArg} does not exist (the filename is case-sensitive: REPORT.md)`);
    } else {
      const body = await rf.text();
      // A deliverable exists, so every earlier handover should be behind it.
      for (const g of ["coverage", "sufficiency"]) {
        if (!passedGates.has(g)) {
          gateSev("gate-skipped", `a report exists but the ${g} gate was never recorded — the user never saw ${g === "coverage" ? "what was found and how much was read" : "which questions had solid evidence"} (ledger.ts gate --pass ${g})`);
        }
      }
      // Strip fenced code, the generated counts block, and the reference list:
      // ids there are being defined, not used, and the counts block is checked
      // separately against the ledger rather than read as prose.
      const prose = body
        .replace(/```[\s\S]*?```/g, "\n")
        .replace(new RegExp(`${STATS_OPEN}[\\s\\S]*?${STATS_CLOSE}`, "g"), "\n")
        .split(REFS_MARKER)[0]
        .replace(/<!--[\s\S]*?-->/g, " ")
        .split(REFS_HEADING)[0] ?? body;

      const citedIds = new Set<string>();
      for (const m of prose.matchAll(/\[((?:S|E|CL)\d+)\]/g)) citedIds.add(m[1].toUpperCase());
      if (!citedIds.size) err("report-uncited", `${reportArg} contains no [S###] citation at all`);

      const knownIds = new Set<string>([
        ...l.sources.map((s) => s.id), ...l.evidence.map((e) => e.id), ...l.claims.map((c) => c.id),
      ]);
      for (const id of citedIds) {
        if (!knownIds.has(id)) err("citation-unknown-id", `${reportArg} cites ${id}, which is not in the ledger — a fabricated citation`);
        else if (id.startsWith("S")) {
          if (!included.has(id)) err("citation-to-excluded-source", `${reportArg} cites ${id}, which did not pass screening`);
          else if (!srcById.get(id)?.read_at) err("citation-to-unread-source", `${reportArg} cites ${id}, which was never read`);
        }
      }

      // Claims recorded but never used. Either the report dropped a finding or
      // the ledger holds a claim nobody stands behind.
      for (const c of l.claims) {
        if (c.consensus === "absent") continue;
        const backing = new Set(c.evidence.map((e) => evById.get(e)?.source).filter(Boolean) as string[]);
        const shown = [...backing].some((s) => citedIds.has(s)) || citedIds.has(c.id);
        if (!shown && backing.size) wrn("claim-absent-from-report", `${c.id} (${c.consensus}) is in the ledger but none of its sources are cited in the report`);
      }

      // Non-negotiable 4 at report level: a paragraph that states a figure and
      // cites nothing. The evidence record may be spotless; the prose is not.
      const paras = prose.split(/\n\s*\n/);
      let bare = 0;
      const bareExamples: string[] = [];
      const abstractOnlyFigures: string[] = [];
      for (const p of paras) {
        const t = p.trim();
        if (!t || t.startsWith("#") || t.startsWith("|") || t.startsWith(">")) continue;
        const stripped = t.replace(/\[(?:S|E|CL)\d+\]/g, " ");
        const hasFigure = /(?<![\p{L}\d._-])\d+(?:[.,]\d+)?\s*%/u.test(stripped)
          || /(?<![\p{L}\d._-])\d{2,}(?![\d\-\p{L}])/u.test(stripped.replace(/\b(19|20)\d{2}\b/g, " "));
        if (hasFigure && !/\[(?:S|E|CL)\d+\]/.test(t)) {
          bare++;
          if (bareExamples.length < 5) bareExamples.push(t.slice(0, 90).replace(/\s+/g, " "));
          continue;
        }
        // Cited, but every source behind the figure was only read as an
        // abstract. The paragraph looks sourced and the number is still
        // unmoored from its method.
        if (hasFigure) {
          const sids = [...new Set([...t.matchAll(/\[(S\d+)\]/g)].map((m) => m[1].toUpperCase()))];
          const known = sids.filter((s) => srcById.has(s));
          if (known.length && known.every((s) => srcById.get(s)?.read_scope === "abstract")) {
            abstractOnlyFigures.push(`${known.join(", ")}: "${t.slice(0, 70).replace(/\s+/g, " ")}…"`);
          }
        }
      }
      for (const ex of bareExamples) err("figure-without-citation", `a figure appears with no citation in the same paragraph: "${ex}…"`);
      if (bare > bareExamples.length) err("figure-without-citation", `… and ${bare - bareExamples.length} more paragraph(s)`);
      for (const ex of abstractOnlyFigures.slice(0, 10)) {
        // quick mode says out loud that it works from abstracts, so there it is
        // a disclosure, not a defect. Anywhere else it is a defect.
        const sev = l.mode === "quick" ? wrn : err;
        sev("report-figure-from-abstract", `a figure rests only on abstract-only source(s) — ${ex}`);
      }

      // Sections that assert things and cite nothing. Warn, because an intro
      // or a method note legitimately cites nothing.
      for (const sec of prose.split(/^(?=##\s)/m)) {
        const head = sec.match(/^##\s+(.+)$/m)?.[1]?.trim();
        if (!head) continue;
        const text = sec.replace(/^##\s+.+$/m, "").trim();
        if (text.length > 400 && !/\[(?:S|E|CL)\d+\]/.test(text)) {
          wrn("section-without-citation", `"${head}" runs ${text.length} chars with no citation — observation or inference? (non-negotiable 7)`);
        }
      }

      if (!AS_OF_PHRASES.test(body) && !body.includes(AS_OF_MARKER)) {
        err("no-currency-line", `${reportArg} has no "Evidence current as of <date>" line (non-negotiable 6) — in an output language this check does not read, mark it with '${AS_OF_MARKER} YYYY-MM-DD -->' next to the line`);
      }

      // The counting rule, checked rather than trusted. A `stats --md` block
      // carries its numbers in a comment payload, so the audit can re-derive
      // them from the ledger and see any hand-edit.
      const openAt = body.indexOf(STATS_OPEN);
      if (openAt === -1) {
        wrn("no-stats-block", `${reportArg} has no ${STATS_OPEN} … --> block — paste 'stats --md' output so the funnel numbers are machine-checked instead of retyped`);
      } else {
        const closeAt = body.indexOf(STATS_CLOSE, openAt);
        if (closeAt === -1) err("stats-block-unterminated", `the ${STATS_OPEN} block in ${reportArg} is missing its ${STATS_CLOSE} marker`);
        const payloadRaw = body.slice(openAt + STATS_OPEN.length, body.indexOf("-->", openAt)).trim();
        let declared: Record<string, unknown> | null = null;
        try { declared = JSON.parse(payloadRaw); }
        catch { err("stats-block-unparseable", `the counts payload in ${reportArg} is not valid JSON — regenerate it with 'stats --md', do not edit it`); }
        if (declared) {
          const truth = statsPayload(computeStats(l)) as Record<string, number>;
          const drift: string[] = [];
          for (const [k, v] of Object.entries(declared)) {
            if (!(k in truth)) { wrn("stats-block-unknown-key", `the counts block declares "${k}", which 'stats --md' does not produce`); continue; }
            if (Number(v) !== truth[k]) drift.push(`${k}: report says ${v}, ledger says ${truth[k]}`);
          }
          if (drift.length) {
            for (const d of drift) err("stats-block-stale", `${d} — regenerate with 'ledger.ts stats --md' (the tool is right, non-negotiable: never hand-count)`);
          }
        }
      }
    }
  }

  const errors = found.filter((f) => f.severity === "error");
  const warns = found.filter((f) => f.severity === "warn");

  if (o.json) {
    out(JSON.stringify({ errors: errors.length, warnings: warns.length, findings: found }, null, 2));
  } else {
    out(`# Ledger audit — ${l.topic || "(untitled)"}`);
    out(`${errors.length} error(s), ${warns.length} warning(s)\n`);
    for (const group of [errors, warns]) {
      if (!group.length) continue;
      out(`## ${group[0].severity === "error" ? "Errors — must be fixed before delivery" : "Warnings — resolve or disclose"}`);
      const byCheck = new Map<string, Finding[]>();
      for (const f of group) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
      for (const [check, fs] of byCheck) {
        out(`\n**${check}** (${fs.length})`);
        for (const f of fs.slice(0, 20)) out(`- ${f.detail}`);
        if (fs.length > 20) out(`- … and ${fs.length - 20} more`);
      }
      out("");
    }
    if (!found.length) out(`No findings.${reportArg ? "" : " Ledger only — rerun with --report to check the deliverable's citations."} What no tool can check is in references/08-quality-gates.md §8.7: does the source really say it, is the quote verbatim, is it the primary source.`);
  }
  if (errors.length) process.exitCode = 1;
}

// -------------------------------------------------------------- run state

/**
 * Where the run stands, derived rather than declared.
 *
 * A long run gets its context compacted, and after that the agent's own sense
 * of "which stage am I in" is the least trustworthy thing in the room. This
 * reads the ledger and the files on disk and answers the question mechanically,
 * so resuming is a lookup instead of a reconstruction.
 */
type StageStatus = "done" | "now" | "todo" | "skip";
type StageState = { n: number; name: string; status: StageStatus; missing: string[]; gate: string | null };

async function computeState(dir: string, l: Ledger) {
  const d = dir.replace(/[\\/]+$/, "");
  const has = async (f: string) => await Bun.file(`${d}/${f}`).exists();
  /** The filename when it is missing, null when it is there — names come from RUN_FILES so `state` and `contract` cannot disagree about them. */
  const miss = async (f: string) => ((await has(f)) ? null : f);
  const quick = l.mode === "quick";
  const s = computeStats(l);
  const p1 = verdictsFor(l, "pass1");
  const included = includedSources(l);

  const stages: StageState[] = [];
  const add = (n: number, name: string, missing: (string | false | null | undefined)[], gate: string | null, skip = false) =>
    stages.push({ n, name, status: skip ? "skip" : "todo", missing: missing.filter(Boolean) as string[], gate });

  add(1, "Scope, criteria, perspectives, outline", [
    await miss(RUN_FILES.brief),
    await miss(RUN_FILES.plan),
    !l.criteria.length && "no criterion registered (add-criterion)",
  ], "scope");

  add(2, "Retrieval", [
    !l.queries.length && "no query logged (log-query)",
    !l.sources.length && "no source in the ledger (add-source)",
    !s.funnel.read && "nothing marked read (mark-read)",
    s.funnel.metadata_only > 0 && `${s.funnel.metadata_only} source(s) still metadata-only, not citable`,
    await miss(RUN_FILES.searchLog),
  ], "coverage");

  add(3, "Screening, evidence, extraction", [
    !p1.size && "nothing screened (screen)",
    s.funnel.unscreened > 0 && `${s.funnel.unscreened} source(s) awaiting screening`,
    !l.evidence.length && "no evidence record (add-evidence)",
    await miss(RUN_FILES.screening),
    !quick && !l.extraction.length && "extraction matrix empty (extract)",
  ], "sufficiency");

  add(4, "Synthesis", [
    !l.claims.length && "no claim recorded (claim)",
    await miss(RUN_FILES.synthesis),
  ], null);

  add(5, "Verification", [
    !l.verification.length && "no verification question (verify)",
    s.verification.claims_unverified > 0 && `${s.verification.claims_unverified} claim(s) unverified`,
    await miss(RUN_FILES.verification),
  ], null);

  add(6, "Knowledge graph", [
    await miss(RUN_FILES.graph),
    await miss(RUN_FILES.graphMd),
  ], null, quick);

  add(7, "Report", [
    await miss(RUN_FILES.report),
    await miss(RUN_FILES.gaps),
  ], null);

  add(8, "Audit", [
    (await miss(RUN_FILES.audit)) && `${RUN_FILES.audit} (paste stats + audit output into it)`,
    `audit --report must exit 0 (run: ledger.ts audit --dir ${dir} --report)`,
  ], "audit");

  add(9, "Learning loop", [
    "ask once what to remember; a blank answer writes nothing",
  ], "memory");

  const passed = new Set((l.gates ?? []).map((g) => g.gate));
  let currentSet = false;
  for (const st of stages) {
    if (st.status === "skip") continue;
    const complete = !st.missing.length && (!st.gate || passed.has(st.gate));
    // Order matters: a later stage whose files happen to exist is not "done"
    // while an earlier one is open, or a half-finished run reads as finished.
    if (currentSet) {
      st.status = "todo";
      if (complete) st.missing = ["outputs already present, but an earlier stage is open"];
      continue;
    }
    if (complete) { st.status = "done"; continue; }
    st.status = "now";
    currentSet = true;
  }

  const current = stages.find((x) => x.status === "now") ?? null;
  return {
    topic: l.topic, mode: l.mode, lang: l.lang,
    created: l.created, updated: l.updated,
    stage: current?.n ?? 9, stage_name: current?.name ?? "complete",
    blocking: current?.missing ?? [],
    stages,
    gates: GATES.map((g) => ({
      gate: g,
      passed: passed.has(g),
      at: (l.gates ?? []).find((x) => x.gate === g)?.at ?? null,
    })),
    counts: {
      sources: s.funnel.identified, read: s.funnel.read, read_fulltext: s.funnel.read_fulltext,
      included: included.length, evidence: l.evidence.length, claims: l.claims.length,
      verification: l.verification.length,
    },
  };
}

async function cmdState(o: Record<string, any>) {
  const dir = need(o, "dir");
  const l = await load(dir);
  const st = await computeState(dir, l);
  if (o.json) { out(JSON.stringify(st, null, 2)); return; }

  const mark: Record<StageStatus, string> = { done: "done", now: ">>>>", todo: "todo", skip: "skip" };
  out(`# Run state — ${st.topic || "(untitled)"}`);
  out(`mode ${st.mode} · lang ${st.lang} · started ${st.created.slice(0, 10)} · updated ${st.updated.slice(0, 16).replace("T", " ")}`);
  out(`stage ${st.stage} — ${st.stage_name}\n`);
  out(`| # | Stage | Status | What is missing |`);
  out(`|---|-------|--------|-----------------|`);
  for (const s of st.stages) {
    out(`| ${s.n} | ${s.name} | ${mark[s.status]} | ${s.status === "done" ? "—" : s.missing.join("; ") || "—"} |`);
  }
  out(`\n## Gates`);
  out(st.gates.map((g) => `${g.gate} ${g.passed ? `passed ${g.at?.slice(0, 10)}` : "—"}`).join(" · "));
  out(`\n## Counts`);
  const c = st.counts;
  out(`${c.sources} sources · ${c.read} read (${c.read_fulltext} full text) · ${c.included} included · ${c.evidence} evidence · ${c.claims} claims · ${c.verification} verification records`);
  if (st.blocking.length) {
    out(`\n## To leave stage ${st.stage}`);
    for (const b of st.blocking) out(`- ${b}`);
  }
  out(`\nEvery count here comes from the ledger. Numbers for a deliverable still come from 'stats'.`);
}

/**
 * Record that a gate was passed, with the user's answer as the note. A gate is
 * a handover to the user, so it is the one piece of run state a tool cannot
 * derive — hence this command, and hence `state` treating a stage with an
 * unpassed gate as unfinished however complete its files look.
 */
async function cmdGate(o: Record<string, any>) {
  const dir = need(o, "dir");
  const l = await load(dir);
  const gate = need(o, "pass");
  if (!GATES.includes(gate)) throw new Error(`--pass must be one of: ${GATES.join(", ")}`);
  l.gates ??= [];
  const already = l.gates.find((g) => g.gate === gate);
  if (already) {
    warn(`${gate} gate was already recorded at ${already.at.slice(0, 16).replace("T", " ")} — overwriting with the newer approval`);
    l.gates = l.gates.filter((g) => g.gate !== gate);
  }
  l.gates.push({ gate, at: now(), note: str(o.note) ?? null });
  await save(dir, l);
  out(`${gate} gate passed${str(o.note) ? `: ${str(o.note)}` : ""}`);
  const st = await computeState(dir, l);
  out(`now at stage ${st.stage} — ${st.stage_name}`);
}

// ------------------------------------------------------------ shared cache

async function cmdCache(o: Record<string, any>) {
  if (o["prune-days"] !== undefined) {
    const days = Number(o["prune-days"]);
    if (!Number.isFinite(days) || days < 0) throw new Error("--prune-days must be 0 or more days (0 clears the cache)");
    const gone = cachePrune(days);
    out(days === 0
      ? `cleared ${gone.length} entr${gone.length === 1 ? "y" : "ies"} from ${cacheDir()}`
      : `pruned ${gone.length} entr${gone.length === 1 ? "y" : "ies"} untouched for ${days}+ days from ${cacheDir()}`);
    return;
  }
  const list = cacheList();
  const st = cacheStatus();
  const bytes = list.reduce((n, e) => n + e.bytes, 0);
  out(`# Shared source cache`);
  out(cacheDir());
  out(`${list.length} entr${list.length === 1 ? "y" : "ies"} · ${(bytes / 1024).toFixed(0)} KB · ${st.note}`);
  if (o.list) for (const e of list.slice(0, 40)) out(`  ${e.mtime.toISOString().slice(0, 10)}  ${String(Math.round(e.bytes / 1024)).padStart(5)} KB  ${e.key}`);
  if (!list.length) out(`Empty — it fills as mark-read and 'scholar.ts fetch' cache full text.`);
  if (!st.supported) {
    warn(`this cache is format v${st.version} and this build reads v${CACHE_VERSION} — every read misses until it is cleared ('cache --prune-days 0') or DRP_CACHE_DIR points elsewhere. The cost is a wasted fetch, never a wrong quote`);
    process.exitCode = 1;
  }
  out(`\nThis cache saves a fetch; it never satisfies non-negotiable 1 on its own. A reused entry is still copied into the run's own sources/S###.md.`);
}

// -------------------------------------------------------------- rendering

async function cmdMatrix(o: Record<string, any>) {
  const l = await load(need(o, "dir"));
  const rows = includedSources(l);
  const cols: string[] = [];
  for (const e of l.extraction) if (!cols.includes(e.column)) cols.push(e.column);
  if (!cols.length) { out("_No extraction data yet._"); return; }

  out(`# Extraction matrix — ${l.topic || ""}`);
  out(`${rows.length} included source(s), ${cols.length} column(s). Rendered from ledger.json; do not edit by hand.\n`);
  out(`| Source | Year | ${cols.join(" | ")} |`);
  out(`|---|---|${cols.map(() => "---").join("|")}|`);
  for (const s of rows) {
    const cells = cols.map((c) => {
      const e = l.extraction.find((x) => x.source === s.id && x.column === c);
      if (!e) return "—";
      // "not reported" and an explicit "inferred:" prefix are honest answers,
      // not missing quotes — audit exempts them, so the legend must too.
      const exempt = /^(not reported|n\/a|none)$/i.test(e.value) || e.value.startsWith("inferred:");
      const mark = e.quote || exempt ? "" : " ⚠";
      return `${e.value.replace(/\|/g, "\\|")}${mark}`;
    });
    out(`| ${s.id} | ${s.year ?? "?"} | ${cells.join(" | ")} |`);
  }
  out(`\n⚠ = no supporting quote recorded (an inference, not an extraction).\n`);
  out(`## Cell provenance`);
  for (const e of l.extraction.filter((x) => x.quote)) {
    out(`- **${e.source}.${e.column}** = ${e.value} — "${e.quote}"${e.locator ? ` (${e.locator})` : ""}`);
  }
}

async function cmdBib(o: Record<string, any>) {
  const l = await load(need(o, "dir"));
  const rows = includedSources(l);
  const today = new Date().toISOString().slice(0, 10);
  out(`## References`);
  out(`${rows.length} included source(s). Rendered from ledger.json.\n`);
  for (const s of rows) {
    const authors = Array.isArray(s.authors) && s.authors.length
      ? (s.authors.length > 3 ? `${s.authors.slice(0, 3).join(", ")}, et al.` : s.authors.join(", "))
      : (s.publisher ?? "Unknown author");
    const bits = [`[${s.id}] ${authors} (${s.year ?? "n.d."}). *${s.title}*.`];
    if (s.venue) bits.push(`${s.venue}.`);
    if (s.doi) bits.push(`DOI: [${s.doi}](https://doi.org/${s.doi}).`);
    else if (s.url) bits.push(`<${s.url}>.`);
    if (s.oa_url) bits.push(`OA: [copy](${s.oa_url}).`);
    bits.push(`Accessed ${s.read_at ?? s.metadata_at ?? today}.`);
    const labels: string[] = [];
    if (s.retracted === true) labels.push("**RETRACTED**");
    if (/preprint/i.test(String(s.kind))) labels.push("**Preprint, not peer reviewed.**");
    if (s.interest_disclosure === "vendor-published") labels.push("**Vendor-published.**");
    if (s.interest_disclosure === "sponsored") labels.push("**Sponsored.**");
    if ((s.anomalies ?? []).length) labels.push(`**Metadata anomaly: ${s.anomalies.join(", ")}.**`);
    if (labels.length) bits.push(labels.join(" "));
    out(bits.join(" "));
    out("");
  }
}

// ------------------------------------------------------------------- help

const HELP = `
ledger.ts — auditable evidence ledger for deep-research-pipeline

Setup
  init            --dir D --topic "…" [--mode standard] [--lang vi]
                  [--query-lang auto|vi,de,ja,ru]
  add-criterion   --dir D --id C1 --direction include|exclude --text "…"
                  [--stage abstract|fulltext|metadata]
                    Pre-register before searching. Re-registering an existing
                    id is refused — amendments must be visible.

Collect
  add-source      --dir D (--file F.json | --json '{…}') [--from web|openalex|…]
                    Accepts scholar.ts output or the executor contract from
                    references/executor-contract.md. Dedups against the ledger.
                    Sets metadata_at only — nothing here is citable yet.
  mark-read       --dir D --source S001 [--from-abstract] [--file P] [--scope abstract|fulltext] [--no-cache]
                  --dir D --all-from-abstract
                    The only way to set read_at, and it refuses unless the text
                    is cached at sources/S001.md (>= ${MIN_CACHE_CHARS} chars).
                    --from-abstract writes that file from the stored abstract.
                    --all-from-abstract does that for every unread source in one
                    pass and names the ones with no usable abstract.
                    Reuses the shared cross-run cache when it holds this DOI,
                    and feeds it after a full-text read. --no-cache opts out.
  log-query       --dir D --q "…" [--source web] [--hits N] [--kept N] [--lang vi]

Screen (Elicit)
  screen          --dir D --source S001 --verdict include|exclude|defer
                  [--stage abstract|fulltext] [--criteria "C1:pass,C2:fail"]
                  [--reason <vocab>] [--quote "…"] [--confidence high]
                  [--reviewer pass1|pass2|human]
                    --reason is mandatory on exclude, from: ${EXCLUSION_REASONS.join(", ")}

Evidence (PaperQA2)
  add-evidence    --dir D --source S001 --question SQ3 --score 1-10
                  --summary "…" [--quote "…"] [--locator "§5.2"] [--scope-note "…"]
                    Refuses below ${KEEP_THRESHOLD} — discard, do not hoard.
                    Cite at ${CITE_THRESHOLD}+. A number in the summary that the
                    quote does not contain is REFUSED here (exit 2), not
                    reported later. Records the source's reading scope, and in
                    systematic mode caps an abstract-only record at ${KEEP_THRESHOLD}.
  contradiction   --dir D --a E001 --b E002 --class ${CONTRADICTION_CLASSES.join("|")} [--note "…"]

Synthesise
  extract         --dir D --source S001 --col n --value "1,204"
                  [--quote "…"] [--locator "§3.1"]
  claim           --dir D [--id CL01] --text "…" --evidence E001,E002
                  --consensus ${CONSENSUS.join("|")}

Verify (CoVe — stage 5)
  verify          --dir D --claim CL001 --question "…" --answer "…"
                  --status ${VERIFY_STATUS.join("|")} [--evidence E001,E002] [--note "…"]
                    One record per verification question. 'unsupported' and an
                    unrecorded 'contradicted' are audit errors, so a claim that
                    fails here cannot ship.

Report
  stats           --dir D [--json] [--md]
                    Every count in a deliverable comes from here. --md prints the
                    funnel inside <!-- drp:stats --> markers with a machine-readable
                    payload; paste it into the deliverable and 'audit --report'
                    re-derives it and errors on any number that was edited.
  audit           --dir D [--json] [--report REPORT.md] [--graph graph.json] [--no-graph]
                    Ledger integrity; exit 1 on errors. Also validates graph.json
                    when present: dangling edges, and every ledger_ids entry must
                    exist, be included, and be read. With --report it checks the
                    deliverable: unknown or excluded [S###], figures in uncited
                    paragraphs, figures resting on abstract-only sources, a stale
                    drp:stats block, missing currency line, claims the report
                    dropped. Bare --report defaults to D/REPORT.md.
  matrix          --dir D              Renders 03-extraction.md
  bib             --dir D              Renders the reference list

Batch (${BATCHABLE.join(", ")})
  <cmd>           --dir D --batch records.jsonl
                    One JSON object per line, keys named like the flags without
                    the dashes (score may be a number, evidence an array,
                    criteria an object). A JSON array file works too.
                    One lock, one write, many records: this is the difference
                    between 300 agent turns and 6. Every line is attempted; the
                    lines that land are written, the lines that fail are named
                    with their line number and are not. Exit 2 if any line was
                    refused by a rule, 1 if any line errored.
                      {"source":"S001","verdict":"include","criteria":{"C1":"pass"}}
                      {"source":"S002","question":"SQ1","score":8,"summary":"…","quote":"…"}

Run state
  state           --dir D [--json]     Which stage, which gates, what is missing.
                                       Derived from the ledger and the files on
                                       disk — the way to resume after a long run.
  gate            --dir D --pass ${GATES.join("|")}
                  [--note "…"]         Record a gate the user approved. Until
                                       then 'state' holds that stage open.
  contract        [--md] [--check FILE]
                                       Prints the tooling contract — vocabularies,
                                       thresholds, filenames, exit codes, env —
                                       generated from the constants the checks
                                       read, between drp:contract markers.
                                       --check FILE exits 1 when the copy
                                       embedded in that file is stale. This is
                                       why references/ledger.md cannot drift.
  cache           [--list] [--prune-days N]
                                       The cross-run source cache: what it
                                       holds, and how to trim it. Override its
                                       location with DRP_CACHE_DIR.

Environment
  DRP_RUN_DIR     default for --dir, so a run sets the directory once
  DRP_CACHE_DIR   relocates the shared cross-run source cache

Preflight: 'bun scholar.ts doctor' checks bun, pdftotext, the API keys, network
reach, and the cache before a run spends its budget.

Unknown flags are rejected with a suggestion — nothing is written. If a flag is
not in this help, it does not exist.

Exit codes: 0 ok, 1 error or audit findings, 2 refused by design.
`;

// ------------------------------------------------------------------- main

/** Commands that read-modify-write the ledger, and so must hold the lock. */
const MUTATING = new Set([
  "init", "add-criterion", "add-source", "mark-read", "log-query", "screen",
  "add-evidence", "contradiction", "extract", "claim", "verify", "gate",
]);

const { cmd, o } = parseArgs(process.argv.slice(2));
let release: (() => void) | null = null;
try {
  // A research directory is the same for every command in a run, so repeating
  // it 400 times is 400 chances to mistype it — and on PowerShell $R is
  // case-insensitive, so a loop variable named $r silently overwrites it.
  // DRP_RUN_DIR is set once; --dir still wins where it is given.
  if (o.dir === undefined && process.env.DRP_RUN_DIR && (FLAGS[cmd] ?? []).includes("dir")) {
    o.dir = process.env.DRP_RUN_DIR;
  }
  checkRunDir(o.dir);
  validateFlags(cmd, o);
  if (o.batch && !BATCHABLE.includes(cmd)) throw new Error(`--batch is only available on: ${BATCHABLE.join(", ")}`);
  if (MUTATING.has(cmd) && typeof o.dir === "string") release = await acquireLock(o.dir);
  switch (cmd) {
    case "init": await cmdInit(o); break;
    case "add-criterion": await cmdAddCriterion(o); break;
    case "add-source": await cmdAddSource(o); break;
    case "mark-read": await cmdMarkRead(o); break;
    case "log-query": await cmdLogQuery(o); break;
    case "screen": await cmdScreen(o); break;
    case "add-evidence": await cmdAddEvidence(o); break;
    case "contradiction": await cmdContradiction(o); break;
    case "extract": await cmdExtract(o); break;
    case "claim": await cmdClaim(o); break;
    case "verify": await cmdVerify(o); break;
    case "stats": await cmdStats(o); break;
    case "audit": await cmdAudit(o); break;
    case "matrix": await cmdMatrix(o); break;
    case "bib": await cmdBib(o); break;
    case "state": await cmdState(o); break;
    case "gate": await cmdGate(o); break;
    case "cache": await cmdCache(o); break;
    case "contract": await cmdContract(o); break;
    case "--help": case "-h": case "help": process.stdout.write(HELP); break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n${HELP}`);
      process.exit(2);
  }
} catch (e) {
  process.stderr.write(`ledger.ts: ${e instanceof Error ? e.message : String(e)}\n`);
  release?.();
  process.exit(e instanceof Refusal ? e.code : 1);
} finally {
  release?.();
}
