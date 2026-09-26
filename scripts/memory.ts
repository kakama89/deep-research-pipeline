/**
 * memory.ts — the cross-run memory for the deep-research-pipeline skill.
 *
 * Holds process knowledge learned from finished runs: user preferences,
 * scoping habits, which sources paid off, which methods wasted time, recurring
 * pitfalls, terminology. It never holds findings. A finding needs a source and
 * an audit; memory has neither, so anything remembered here is a hint about
 * *how* to research, never a fact to cite.
 *
 * The point of this file existing: the blank rule and duplicate suppression
 * must not depend on an LLM's discipline. `add` refuses empty input and
 * refuses to store something the file already says. Semantic compaction — the
 * judgement half — is the agent's job, done before calling `add`.
 *
 * Store format: memory.md, one entry per line under a `## <kind>` heading.
 *
 *   ## preference
 *   - [2026-09-02] Report in Vietnamese, keep English technical terms. {tags: lang}
 *
 * Run `bun memory.ts --help` for usage.
 */

// ----------------------------------------------------------------- schema

type Entry = { kind: string; date: string; text: string; tags: string[] };

const KINDS = ["preference", "scope", "source", "method", "pitfall", "terminology"];

/**
 * The store format this build understands.
 *
 * `memory.md` outlives every run, so it is the one file a newer skill build can
 * meet and misread — silently, because the parser skips any line it does not
 * recognise. A file stamped with a version this build does not know is read but
 * never written: losing an unfamiliar entry is worse than refusing to edit.
 * A file with no stamp at all predates versioning and upgrades on the next write.
 */
const MEMORY_VERSION = 1;
const VERSION_RE = /<!--\s*drp:memory\s+v(\d+)\s*-->/;

const CAP_ENTRIES_TOTAL = 40;
const CAP_ENTRIES_PER_KIND = 12;
const CAP_ENTRY_CHARS = 200;
const CAP_FILE_BYTES = 8192;
/** Token overlap at or above this is treated as the same entry. */
const DUP_THRESHOLD = 0.8;
/** Between these two, the entries are close enough to need a human/LLM look. */
const REVIEW_THRESHOLD = 0.55;

const HEADER = `# Research memory — deep-research-pipeline

<!-- drp:memory v${MEMORY_VERSION} -->

Loaded at the start of every run, before stage 1. Process knowledge only:
how to research this user's questions well. Never a finding, never something
a report could cite — memory records carry no source and no audit.

Written only by scripts/memory.ts. One entry per line under a kind heading.
`;

// --------------------------------------------------------------- plumbing

const out = (s: string) => process.stdout.write(s + "\n");
const warn = (s: string) => process.stderr.write(`  ${s}\n`);
const today = () => new Date().toISOString().slice(0, 10);

function parseArgs(argv: string[]) {
  const cmd = argv[0] ?? "--help";
  const o: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const nxt = argv[i + 1];
    if (nxt && !nxt.startsWith("--")) { o[k] = nxt; i++; } else o[k] = true;
  }
  return { cmd, o };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const memPath = (o: Record<string, any>) =>
  str(o.path) ?? `${import.meta.dir.replace(/[\\/]+scripts$/, "")}/memory.md`;

/** Collapse whitespace, strip list bullets and trailing punctuation noise. */
function normalise(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/^[-*•\s]+/, "")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "been", "it", "this", "that", "as", "at",
  "by", "from", "not", "no", "so", "if", "when", "than", "then", "use", "used",
  "và", "là", "của", "cho", "với", "các", "những", "một", "khi", "thì", "nên",
]);

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

/** Jaccard overlap of content words. Cheap, language-agnostic, good enough. */
function similarity(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// ------------------------------------------------------------ read / write

type Store = {
  /** null = no stamp: written before the format was versioned, or no file yet. */
  version: number | null;
  entries: Entry[];
  exists: boolean;
};

async function read(path: string): Promise<Store> {
  const f = Bun.file(path);
  if (!(await f.exists())) return { version: null, entries: [], exists: false };
  const body = await f.text();
  const entries: Entry[] = [];
  let kind = "preference";
  for (const raw of body.split(/\r?\n/)) {
    const h = raw.match(/^##\s+([a-z]+)\s*$/);
    if (h) { kind = h[1]; continue; }
    const m = raw.match(/^-\s+\[(\d{4}-\d{2}-\d{2})\]\s+(.*?)(?:\s*\{tags:\s*([^}]*)\})?\s*$/);
    if (!m) continue;
    entries.push({
      kind, date: m[1], text: normalise(m[2]),
      tags: (m[3] ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    });
  }
  const v = body.match(VERSION_RE);
  return { version: v ? Number(v[1]) : null, entries, exists: true };
}

/**
 * Refuse to write a file a newer build wrote.
 *
 * The parser silently drops any line it does not recognise, so rewriting a v2
 * file with a v1 writer would delete whatever v2 added and report success. A
 * read-only refusal keeps the file intact and names the fix.
 */
function assertWritable(store: Store, path: string): void {
  if (store.version !== null && store.version > MEMORY_VERSION) {
    throw new Error(
      `${path} is memory format v${store.version}; this build writes v${MEMORY_VERSION}.\n` +
      `  Refusing to rewrite it — a v${MEMORY_VERSION} writer would drop whatever v${store.version} added.\n` +
      `  Update the skill, or move that file aside and start a fresh memory.`,
    );
  }
}

async function write(path: string, entries: Entry[]) {
  const lines = [HEADER];
  for (const k of KINDS) {
    const group = entries.filter((e) => e.kind === k)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!group.length) continue;
    lines.push(`## ${k}`);
    for (const e of group) {
      lines.push(`- [${e.date}] ${e.text}${e.tags.length ? ` {tags: ${e.tags.join(", ")}}` : ""}`);
    }
    lines.push("");
  }
  await Bun.write(path, lines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

// -------------------------------------------------------------- commands

async function cmdShow(o: Record<string, any>) {
  const path = memPath(o);
  const f = Bun.file(path);
  if (!(await f.exists())) {
    out(`# No memory yet (${path})`);
    warn("nothing to load — this is the normal state for a first run");
    return;
  }
  out((await f.text()).trimEnd());
  const store = await read(path);
  if (store.version !== null && store.version > MEMORY_VERSION) {
    warn(`this file is memory format v${store.version} and this build writes v${MEMORY_VERSION} — it is safe to read, but 'add', 'replace', 'forget' and 'compact' will refuse to rewrite it. Update the skill before stage 9`);
  } else if (store.version === null && store.entries.length) {
    warn(`written before the format was versioned — it will be stamped v${MEMORY_VERSION} on the next write, with no change to the entries`);
  }
}

/**
 * The blank rule lives here. Empty, whitespace-only, or a refusal means the
 * user chose not to remember anything, and nothing is written — not even an
 * empty memory.md.
 */
const BLANK_TOKENS = new Set([
  "", "-", "--", "n/a", "na", "no", "none", "nothing", "skip", "nope", "nah",
  "không", "khong", "ko", "không có", "khong co", "bỏ qua", "bo qua", "thôi", "thoi",
]);

/**
 * Conversational refusals: "nah don't bother", "not this time", "thôi khỏi".
 * Only applied to short input — a real lesson that happens to start with "no"
 * or "không" ("Không dùng Semantic Scholar khi thiếu key") is longer than this
 * and is stored normally.
 */
const REFUSAL_MAX_CHARS = 30;
const REFUSAL_PATTERNS = [
  /^(no|nope|nah|none|nothing|not)\b/i,
  /^(don'?t|do not)\s+(bother|worry|save|store|remember)/i,
  /^(skip|pass|forget)\s+(it|this|that|for now)/i,
  /^(maybe|another)\s+(later|time|next time)/i,
  /^(thôi|thoi|khỏi|khoi|không|khong|ko|chưa|chua)\b/i,
];

function isRefusal(text: string): boolean {
  const t = text.toLowerCase().replace(/[.!…]+$/, "").trim();
  if (BLANK_TOKENS.has(t)) return true;
  if (t.length > REFUSAL_MAX_CHARS) return false;
  return REFUSAL_PATTERNS.some((p) => p.test(t));
}

/** Ids mean the text is evidence, not process knowledge (00-contract.md non-negotiable 12). */
const CITATION_RE = /\[(?:S|E|CL|V)\d{2,3}\]/;

/** Softer smells: usually a sign the entry was not compacted semantically. */
const SMELLS: [RegExp, string][] = [
  [/\d+(?:\.\d+)?\s?%/, "contains a percentage — if that is a finding it belongs in the report, not in memory"],
  [/\b(19|20)\d{2}\b(?!\+)/, "contains a year — a year as data is a finding; a date window is a scope rule, so phrase it as one"],
  [/\b(this run|this report|this study|the user said|as we saw|last time we)\b/i, "still run-specific — strip it so the lesson fires on a question you have not seen yet"],
  [/\b(remember that|note that|keep in mind that)\b/i, "opens with filler — state the lesson directly"],
];

async function cmdAdd(o: Record<string, any>) {
  const path = memPath(o);
  const raw = str(o.text) ?? "";
  const text = normalise(raw);
  if (!text || isRefusal(text)) {
    warn("blank or a refusal — nothing remembered, memory.md untouched");
    process.exitCode = 2;   // 2 = deliberately nothing to do, not a failure
    return;
  }
  const kind = str(o.kind) ?? "preference";
  if (!KINDS.includes(kind)) throw new Error(`--kind must be one of: ${KINDS.join(", ")}`);
  if (text.length > CAP_ENTRY_CHARS) {
    throw new Error(`entry is ${text.length} chars, cap is ${CAP_ENTRY_CHARS} — compact it semantically first (one lesson per entry)`);
  }
  // Code backstop for non-negotiable 12: a ledger id in memory means someone is
  // trying to store evidence. Memory carries no source and no audit, so refuse.
  if (CITATION_RE.test(text)) {
    throw new Error("entry cites a ledger id — memory holds process knowledge, never evidence. Put the finding in REPORT.md instead (00-contract.md non-negotiable 12)");
  }
  for (const [re, why] of SMELLS) if (re.test(text)) warn(`not compacted? ${why}`);

  const store = await read(path);
  assertWritable(store, path);
  const entries = store.entries;
  for (const e of entries) {
    const sim = similarity(e.text, text);
    if (sim >= DUP_THRESHOLD) {
      warn(`already remembered (${Math.round(sim * 100)}% overlap with the ${e.kind} entry from ${e.date}):`);
      warn(`  "${e.text}"`);
      warn("nothing added — merge the new nuance into that entry with 'replace' if it says more");
      process.exitCode = 2;
      return;
    }
    if (sim >= REVIEW_THRESHOLD) {
      warn(`close to the ${e.kind} entry from ${e.date} (${Math.round(sim * 100)}%): "${e.text}"`);
      warn("added anyway — consider merging the two into one sentence");
    }
  }

  entries.push({
    kind, date: str(o.date) ?? today(), text,
    tags: (str(o.tags) ?? "").split(",").map((t) => t.trim()).filter(Boolean),
  });
  await write(path, entries);
  out(`remembered under ${kind}: ${text}`);

  const perKind = entries.filter((e) => e.kind === kind).length;
  if (perKind > CAP_ENTRIES_PER_KIND) warn(`${kind} now holds ${perKind} entries (cap ${CAP_ENTRIES_PER_KIND}) — run 'compact'`);
  if (entries.length > CAP_ENTRIES_TOTAL) warn(`memory now holds ${entries.length} entries (cap ${CAP_ENTRIES_TOTAL}) — run 'compact'`);
  const bytes = (await Bun.file(path).arrayBuffer()).byteLength;
  if (bytes > CAP_FILE_BYTES) warn(`memory.md is ${bytes} bytes (cap ${CAP_FILE_BYTES}) — run 'compact'`);
}

async function cmdReplace(o: Record<string, any>) {
  const path = memPath(o);
  const target = normalise(str(o.match) ?? "");
  if (!target) throw new Error("--match is required (a distinctive phrase from the entry to replace)");
  const text = normalise(str(o.text) ?? "");
  if (!text) throw new Error("--text is required");
  const store = await read(path);
  assertWritable(store, path);
  const entries = store.entries;
  const hits = entries.filter((e) => e.text.toLowerCase().includes(target.toLowerCase()) || similarity(e.text, target) >= DUP_THRESHOLD);
  if (!hits.length) throw new Error(`no entry matches "${target}"`);
  if (hits.length > 1) throw new Error(`"${target}" matches ${hits.length} entries — be more specific`);
  const e = hits[0];
  const before = e.text;
  e.text = text;
  e.date = str(o.date) ?? today();
  if (str(o.kind)) {
    const k = need_kind(str(o.kind)!);
    e.kind = k;
  }
  await write(path, entries);
  out(`replaced under ${e.kind}:\n  was: ${before}\n  now: ${e.text}`);
}

function need_kind(k: string): string {
  if (!KINDS.includes(k)) throw new Error(`--kind must be one of: ${KINDS.join(", ")}`);
  return k;
}

async function cmdForget(o: Record<string, any>) {
  const path = memPath(o);
  const target = normalise(str(o.match) ?? "");
  if (!target) throw new Error("--match is required");
  const store = await read(path);
  assertWritable(store, path);
  const entries = store.entries;
  const keep = entries.filter((e) => !e.text.toLowerCase().includes(target.toLowerCase()));
  const removed = entries.length - keep.length;
  if (!removed) throw new Error(`no entry matches "${target}"`);
  if (removed > 1 && !o.all) throw new Error(`"${target}" matches ${removed} entries — pass --all to remove them all`);
  await write(path, keep);
  out(`forgot ${removed} entr${removed === 1 ? "y" : "ies"}`);
}

/**
 * Syntactic compaction. Deterministic, and therefore the only half that can be
 * trusted to a script: normalise, drop exact and near duplicates (keeping the
 * longer text and the earlier date), enforce the caps, re-sort. Anything that
 * needs meaning collapsed rather than text deduplicated is reported for the
 * agent to handle semantically.
 */
async function cmdCompact(o: Record<string, any>) {
  const path = memPath(o);
  const store = await read(path);
  if (o.apply) assertWritable(store, path);
  const before = store.entries;
  if (!before.length) { out("nothing to compact"); return; }

  const kept: Entry[] = [];
  const merged: string[] = [];
  for (const e of before) {
    // Fold across kinds, not just within one: the same lesson filed twice under
    // different kinds is still the same lesson, and `add` refuses it the same way.
    const twin = kept.find((k) => similarity(k.text, e.text) >= DUP_THRESHOLD);
    if (!twin) { kept.push({ ...e, text: normalise(e.text) }); continue; }
    merged.push(`"${e.text}" (${e.kind}) folded into "${twin.text}" (${twin.kind})`);
    if (e.text.length > twin.text.length) twin.text = normalise(e.text);
    if (e.date < twin.date) twin.date = e.date;
    twin.tags = [...new Set([...twin.tags, ...e.tags])];
  }

  const dropped: string[] = [];
  for (const k of KINDS) {
    const group = kept.filter((e) => e.kind === k).sort((a, b) => b.date.localeCompare(a.date));
    for (const e of group.slice(CAP_ENTRIES_PER_KIND)) {
      dropped.push(`${k}/${e.date}: ${e.text}`);
      kept.splice(kept.indexOf(e), 1);
    }
  }
  const overflow = kept.sort((a, b) => b.date.localeCompare(a.date)).slice(CAP_ENTRIES_TOTAL);
  for (const e of overflow) {
    dropped.push(`${e.kind}/${e.date}: ${e.text}`);
    kept.splice(kept.indexOf(e), 1);
  }

  const review: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const sim = similarity(kept[i].text, kept[j].text);
      // Only the middle band lands here: below it the entries are unrelated,
      // at or above it they were already folded as duplicates.
      if (sim >= REVIEW_THRESHOLD && sim < DUP_THRESHOLD) {
        review.push(`${Math.round(sim * 100)}%: "${kept[i].text}" / "${kept[j].text}"`);
      }
    }
  }

  out(`# Compaction — ${before.length} entries in, ${kept.length} out`);
  if (merged.length) { out(`\n## Merged as duplicates (${merged.length})`); for (const m of merged) out(`- ${m}`); }
  if (dropped.length) { out(`\n## Dropped, over cap (${dropped.length})`); for (const d of dropped) out(`- ${d}`); }
  if (review.length) {
    out(`\n## Overlapping but not identical (${review.length}) — collapse these by meaning, then 'replace'`);
    for (const r of review) out(`- ${r}`);
  }
  if (!merged.length && !dropped.length && !review.length) out("\nNothing to do syntactically.");

  if (o.apply) { await write(path, kept); out(`\nwritten to ${path}`); }
  else out(`\ndry run — re-run with --apply to write`);
}

async function cmdStats(o: Record<string, any>) {
  const path = memPath(o);
  const store = await read(path);
  const entries = store.entries;
  const f = Bun.file(path);
  const bytes = (await f.exists()) ? (await f.arrayBuffer()).byteLength : 0;
  const s = {
    path, entries: entries.length, bytes,
    format: { version: store.version, writes: MEMORY_VERSION, writable: store.version === null || store.version <= MEMORY_VERSION },
    by_kind: Object.fromEntries(KINDS.map((k) => [k, entries.filter((e) => e.kind === k).length])),
    oldest: entries.map((e) => e.date).sort()[0] ?? null,
    newest: entries.map((e) => e.date).sort().at(-1) ?? null,
    over_cap: {
      total: entries.length > CAP_ENTRIES_TOTAL,
      bytes: bytes > CAP_FILE_BYTES,
      kinds: KINDS.filter((k) => entries.filter((e) => e.kind === k).length > CAP_ENTRIES_PER_KIND),
      long_entries: entries.filter((e) => e.text.length > CAP_ENTRY_CHARS).map((e) => e.text.slice(0, 40) + "…"),
    },
  };
  if (o.json) { out(JSON.stringify(s, null, 2)); return; }
  out(`# Memory stats`);
  out(`${s.entries} entries · ${s.bytes} bytes · ${s.oldest ?? "—"} to ${s.newest ?? "—"}`);
  out(`format v${s.format.version ?? "unstamped"} · this build writes v${s.format.writes}${s.format.writable ? "" : " · READ-ONLY here"}`);
  out(Object.entries(s.by_kind).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ") || "empty");
  const c = s.over_cap;
  if (c.total || c.bytes || c.kinds.length || c.long_entries.length) {
    out(`\nover cap:`);
    if (c.total) out(`- ${s.entries} entries (cap ${CAP_ENTRIES_TOTAL})`);
    if (c.bytes) out(`- ${s.bytes} bytes (cap ${CAP_FILE_BYTES})`);
    for (const k of c.kinds) out(`- ${k} (cap ${CAP_ENTRIES_PER_KIND} per kind)`);
    for (const l of c.long_entries) out(`- entry over ${CAP_ENTRY_CHARS} chars: ${l}`);
    out(`run 'compact --apply'`);
  }
}

// ------------------------------------------------------------------- help

const HELP = `
memory.ts — cross-run memory for deep-research-pipeline

Process knowledge only: preferences, scoping habits, which sources paid off,
which methods wasted time, recurring pitfalls, terminology. Never a finding.
A finding needs a source and an audit; memory has neither.

  show      [--path P]                Print memory.md. Run this before stage 1
  add       --text "…" [--kind K] [--tags a,b] [--date YYYY-MM-DD]
                                      Blank input or a refusal writes nothing
                                      (exit 2). Near-duplicates are refused
                                      (exit 2). A ledger id in the text is
                                      rejected — memory is not evidence.
                                      Cap ${CAP_ENTRY_CHARS} chars — one lesson per entry
  replace   --match "phrase" --text "…" [--kind K]
                                      Rewrite one entry in place
  forget    --match "phrase" [--all]  Remove entries
  compact   [--apply]                 Syntactic pass: normalise, fold
                                      duplicates (>=${Math.round(DUP_THRESHOLD * 100)}% token overlap), enforce
                                      caps, re-sort. Reports pairs that need
                                      collapsing by meaning instead. Dry run
                                      unless --apply
  stats     [--json]                  Counts, bytes, cap breaches

  --kind    ${KINDS.join(" | ")}
  --path    override the memory file (default: the skill's own memory.md)

Exit codes: 0 wrote or reported, 1 error, 2 nothing to remember (by design).
`;

// ------------------------------------------------------------------- main

const { cmd, o } = parseArgs(process.argv.slice(2));
try {
  switch (cmd) {
    case "show": await cmdShow(o); break;
    case "add": await cmdAdd(o); break;
    case "replace": await cmdReplace(o); break;
    case "forget": await cmdForget(o); break;
    case "compact": await cmdCompact(o); break;
    case "stats": await cmdStats(o); break;
    case "--help": case "-h": case "help": out(HELP); break;
    default: out(HELP); throw new Error(`unknown command: ${cmd}`);
  }
} catch (e) {
  process.stderr.write(`memory.ts: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
