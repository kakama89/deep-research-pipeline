#!/usr/bin/env bun
/**
 * cache.ts — the cross-run source cache for the deep-research-pipeline skill.
 *
 * A research directory is per-question; a paper is not. Two runs a week apart
 * on neighbouring topics will meet the same DOIs, and re-fetching them costs
 * an API call, a PDF conversion, and sometimes a rate limit. This module
 * keeps one copy per identifier at the skill root and lets `mark-read` and
 * `scholar.ts fetch` reuse it.
 *
 * What it deliberately does NOT do: satisfy non-negotiable 1 on its own. A
 * cache hit still has to be written into the run's own sources/S###.md before
 * `mark-read` will stamp `read_at`, so the run stays self-contained and
 * auditable after the cache is gone.
 *
 * Layout:
 *   <skill root>/cache/<key>.md
 * where <key> is doi-…, pmid-…, arxiv-…, oa-…, url-…, or title-… followed by
 * a short hash. Override the location with DRP_CACHE_DIR (tests use it).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The cache format this build understands.
 *
 * Entries are keyed by `cacheKey`, so the key algorithm is part of the format:
 * change the precedence or the hash and every existing file becomes
 * unreachable — harmlessly, but silently, which is the problem. A future build
 * that changes either must bump this, and then old entries are ignored rather
 * than half-read. `ledger.json` has carried a `version` since it existed; the
 * cache and `memory.md` are the two stores that outlive a run, and they were
 * the two with no version at all.
 */
export const CACHE_VERSION = 1;
/** Bump only when the key algorithm or the file layout changes. */
const KEY_ALGO = "sha1-12/doi>pmcid>pmid>arxiv>oa>url>title";

export type CacheMeta = { version: number; key_algo: string; created: string; updated: string };
export type CacheStatus = {
  path: string;
  version: number | null;      // null = no marker: pre-versioning, or empty
  supported: boolean;
  legacy: boolean;             // entries exist but the marker does not
  entries: number;
  note: string;
};

export type CacheIdent = {
  doi?: string | null; pmid?: string | null; pmcid?: string | null;
  arxiv?: string | null; openalex?: string | null; url?: string | null;
  title?: string | null; year?: number | string | null;
};

const short = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

const normDoi = (d: string) =>
  d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "").trim().toLowerCase();

const normUrl = (u: string) => {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const p of [...x.searchParams.keys()]) {
      if (/^(utm_|ref|source|fbclid|gclid)/i.test(p)) x.searchParams.delete(p);
    }
    return `${x.origin}${x.pathname.replace(/\/+$/, "")}${x.search}`.toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
};

const normTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The cache key, using the same identifier precedence as scholar.ts dedup:
 * DOI > PMID/PMCID > arXiv > OpenAlex > URL > normalised title+year. Returns
 * null when a record carries nothing stable enough to key on — better no
 * cache entry than a wrong one.
 */
export function cacheKey(r: CacheIdent): string | null {
  if (r.doi) return `doi-${short(normDoi(String(r.doi)))}`;
  if (r.pmcid) return `pmcid-${short(String(r.pmcid).trim().toUpperCase())}`;
  if (r.pmid) return `pmid-${short(String(r.pmid).trim())}`;
  if (r.arxiv) return `arxiv-${short(String(r.arxiv).replace(/v\d+$/i, "").trim().toLowerCase())}`;
  if (r.openalex) return `oa-${short(String(r.openalex).trim().toUpperCase())}`;
  if (r.url) return `url-${short(normUrl(String(r.url)))}`;
  const t = r.title ? normTitle(String(r.title)) : "";
  if (t.length >= 12) return `title-${short(`${t}|${r.year ?? ""}`)}`;
  return null;
}

export function cacheDir(): string {
  const env = process.env.DRP_CACHE_DIR;
  if (env) return env.replace(/[\\/]+$/, "");
  return fileURLToPath(new URL("../cache", import.meta.url)).replace(/[\\/]+$/, "");
}

export const cachePath = (key: string) => `${cacheDir()}/${key}.md`;

// ------------------------------------------------------------- versioning

const metaPath = () => `${cacheDir()}/.drp-cache.json`;

function readMeta(): CacheMeta | null {
  try {
    const m = JSON.parse(readFileSync(metaPath(), "utf8"));
    return Number.isFinite(m?.version) ? m as CacheMeta : null;
  } catch { return null; }
}

/** Stamp the marker. Called whenever the cache is written to, so a legacy cache upgrades itself. */
function writeMeta(): void {
  const now = new Date().toISOString();
  const prev = readMeta();
  const m: CacheMeta = {
    version: CACHE_VERSION, key_algo: KEY_ALGO,
    created: prev?.created ?? now, updated: now,
  };
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(metaPath(), JSON.stringify(m, null, 2));
  } catch { /* the cache is an optimisation; failing to stamp it must not fail a run */ }
}

/**
 * What the cache on disk is, and whether this build may read it.
 *
 * A cache written by a newer build may key entries differently, so reading it
 * would either miss (wasteful but safe) or hit the wrong text (not safe). When
 * the version is one this build does not know, every read misses and the caller
 * is told to point `DRP_CACHE_DIR` elsewhere or prune — the run then costs a few
 * extra fetches instead of quoting the wrong paper.
 */
export function cacheStatus(): CacheStatus {
  const path = cacheDir();
  const entries = cacheList().length;
  const m = readMeta();
  if (m) {
    const supported = m.version === CACHE_VERSION;
    return {
      path, version: m.version, supported, legacy: false, entries,
      note: supported
        ? `format v${m.version}`
        : `format v${m.version}, this build reads v${CACHE_VERSION} — entries are ignored. Point DRP_CACHE_DIR at a fresh directory, or run 'ledger.ts cache --prune-days 0' to clear it`,
    };
  }
  if (!entries) return { path, version: null, supported: true, legacy: false, entries: 0, note: "empty — stamped v" + CACHE_VERSION + " on first write" };
  // Entries but no marker: written before the cache was versioned. v1 keys the
  // same way those entries were keyed, so they stay valid; stamp on next write.
  return {
    path, version: null, supported: true, legacy: true, entries,
    note: `${entries} entr${entries === 1 ? "y" : "ies"} written before the format was versioned — still readable, stamped v${CACHE_VERSION} on the next write`,
  };
}

/** True when this build may read what is on disk. */
const readable = (): boolean => cacheStatus().supported;

/** Cached text for this key, or null. Entries below 200 chars are stubs and ignored. */
export async function readCache(key: string | null): Promise<string | null> {
  if (!key) return null;
  if (!readable()) return null;          // a format this build does not understand
  const f = Bun.file(cachePath(key));
  if (!(await f.exists())) return null;
  const t = await f.text();
  return t.trim().length >= 200 ? t : null;
}

/**
 * Store text under this key. Atomic (temp + rename) so a concurrent reader
 * never sees half a file. Returns the path written, or null when there was no
 * usable key.
 */
export async function writeCache(key: string | null, text: string): Promise<string | null> {
  if (!key || text.trim().length < 200) return null;
  if (!readable()) return null;          // do not mix formats in one directory
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const p = cachePath(key);
  const tmp = `${p}.tmp-${process.pid}`;
  await Bun.write(tmp, text);
  renameSync(tmp, p);
  writeMeta();
  return p;
}

/**
 * Rewrite the per-run header of a cached file so a reused entry does not
 * claim the ledger id of the run that first fetched it, and says out loud
 * that it came from the cache.
 */
export function restamp(text: string, id: string, key: string): string {
  const today = new Date().toISOString().slice(0, 10);
  let t = text.replace(/^- id: .*$/m, `- id: ${id}`);
  if (!/^- id: /m.test(t)) t = t.replace(/\n/, `\n\n- id: ${id}\n`);
  if (/^- reused-from-cache:/m.test(t)) {
    t = t.replace(/^- reused-from-cache:.*$/m, `- reused-from-cache: ${key} on ${today}`);
  } else {
    t = t.replace(/^- id: .*$/m, `- id: ${id}\n- reused-from-cache: ${key} on ${today}`);
  }
  return t;
}

export type CacheEntry = { key: string; bytes: number; mtime: Date };

export function cacheList(): CacheEntry[] {
  const dir = cacheDir();
  if (!existsSync(dir)) return [];
  const outp: CacheEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const st = statSync(`${dir}/${name}`);
    outp.push({ key: name.replace(/\.md$/, ""), bytes: st.size, mtime: st.mtime });
  }
  return outp.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/** Delete entries untouched for `days`. Returns what went. `days` of 0 clears the cache. */
export function cachePrune(days: number): CacheEntry[] {
  const cutoff = Date.now() - days * 86_400_000;
  const gone: CacheEntry[] = [];
  for (const e of cacheList()) {
    if (e.mtime.getTime() >= cutoff) continue;
    try { unlinkSync(cachePath(e.key)); gone.push(e); } catch { /* already gone */ }
  }
  // An emptied directory is a fresh cache, whatever format it held before, so
  // re-stamp it. Without this, clearing an unreadable cache left the old marker
  // behind and every later write was still refused.
  if (gone.length && !cacheList().length) {
    try { unlinkSync(metaPath()); } catch { /* nothing to remove */ }
    writeMeta();
  }
  return gone;
}
