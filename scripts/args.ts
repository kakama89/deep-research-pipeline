/**
 * args.ts — flag parsing and flag validation shared by ledger.ts and scholar.ts.
 *
 * Both scripts used to accept `--anything` and ignore what they did not
 * recognise. For a tool whose output is evidence that is the worst possible
 * default: `--locater` instead of `--locator` wrote a record with no locator
 * and said nothing, and no later audit rule can tell "no locator given" from
 * "locator misspelt". A rejected flag costs one retry; a silently dropped one
 * costs a wrong citation.
 */

export type Flags = Record<string, string | boolean>;

/** `--key value` and `--flag`. Bare words are ignored, as before. */
export function parseArgs(argv: string[]): { cmd: string; o: Flags } {
  const cmd = argv[0] ?? "--help";
  const o: Flags = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const nxt = argv[i + 1];
    if (nxt && !nxt.startsWith("--")) { o[k] = nxt; i++; } else o[k] = true;
  }
  return { cmd, o };
}

/** Levenshtein, only ever comparing flag names. */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = cur;
    }
  }
  return prev[b.length];
}

/** The closest allowed flag, when one is close enough to be worth naming. */
export function suggest(bad: string, allowed: string[]): string | null {
  const ranked = allowed
    .map((f) => ({ f, d: editDistance(bad.toLowerCase(), f.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(x.f.length / 3)))
    .sort((a, b) => a.d - b.d);
  return ranked.length ? ranked[0].f : null;
}

/**
 * Throw on any flag (or batch-record key) the command does not know.
 *
 * `inRecord` switches the wording from "flag" to "key" and rejects the two
 * keys that only make sense on the command line. Line numbering belongs to the
 * caller, which knows which batch line it is on.
 */
export function validateFlags(
  cmd: string,
  o: Record<string, unknown>,
  table: Record<string, string[]>,
  inRecord = false,
): void {
  const allowed = table[cmd];
  if (!allowed) return;
  for (const k of Object.keys(o)) {
    if (k === "help" || allowed.includes(k)) continue;
    if (inRecord && (k === "dir" || k === "batch")) {
      throw new Error(`"${k}" belongs on the command line, not in a batch record`);
    }
    const near = suggest(k, allowed);
    throw new Error(
      `unknown ${inRecord ? "key" : "flag"} "${k}" for '${cmd}'${near ? ` — did you mean "${near}"?` : ""}\n` +
      `  ${cmd} accepts: ${allowed.join(", ")}\n` +
      `  Nothing was written. If a flag is not in --help, it does not exist.`,
    );
  }
}
