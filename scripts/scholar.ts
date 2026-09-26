#!/usr/bin/env bun
/**
 * scholar.ts — multi-source scholarly retrieval for the deep-research-pipeline skill.
 *
 * Sources: OpenAlex (backbone), Semantic Scholar (enrichment), Crossref,
 * Europe PMC. All keyless-capable; keys read from the environment if set.
 *
 * Design notes
 *  - Exponential backoff on 429/5xx, honouring Retry-After.
 *  - Records normalised to one schema so dedup can span sources.
 *  - API keys are never written to stdout, stderr, or any output file.
 *  - OpenAlex is metered: cost_usd per call is summed and reported.
 *
 * Run `bun scholar.ts --help` for usage.
 */

import { mkdirSync, unlinkSync } from "node:fs";
import { parseArgs, validateFlags } from "./args.ts";
import { cacheDir, cacheKey, cacheList, cacheStatus, readCache, writeCache } from "./cache.ts";

// ---------------------------------------------------------------- types

export type Rec = {
  id: string | null; // ledger id, assigned by dedup
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  arxiv: string | null;
  openalex: string | null;
  corpus_id: string | null;
  url: string | null;
  oa_url: string | null;
  abstract: string | null;
  tldr: string | null;
  citations: number | null;
  kind: string;
  retracted: boolean | null;
  language: string | null;
  topic: string | null;
  referenced_works: string[];
  source_api: string;
  query: string | null;
  /**
   * The day the metadata arrived — NOT evidence that anyone read the work.
   * Only `ledger.ts mark-read` can set `read_at`, and only once the text is
   * cached on disk. See 00-contract.md non-negotiable 1.
   */
  metadata_at: string | null;
  found_by: string[];
  anomalies: string[];
};

const OPENALEX = "https://api.openalex.org";
const S2 = "https://api.semanticscholar.org/graph/v1";
const CROSSREF = "https://api.crossref.org";
const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";


// ---- peer-reviewed tier -------------------------------------------------
// Measured live against OpenAlex 2026-09-03 on "retrieval augmented
// generation": 29,787 works unfiltered, 7,592 with the clause below. The
// type list must include conference-paper and the source list book series,
// or the whole LNCS/CCIS proceedings literature disappears -- the single
// largest venue in the filtered set is Lecture Notes in Computer Science.
export const OA_PEER_REVIEWED = [
  "type:article|review|conference-paper",
  "primary_location.source.type:journal|conference|book series",
  "has_doi:true",
];

/**
 * Repositories whose records can carry a journal-ish source type. The API
 * filters catch nearly everything; this is the last net, applied after dedup.
 */
const PREPRINT_VENUES = [
  "arxiv", "biorxiv", "medrxiv", "chemrxiv", "ssrn", "research square",
  "preprints.org", "techrxiv", "psyarxiv", "osf preprints", "hal preprint",
  "zenodo", "authorea", "jxiv", "essoar", "scielo preprints",
];

export function isPreprintVenue(venue: string | null | undefined): boolean {
  if (!venue) return false;
  const v = String(venue).toLowerCase();
  return PREPRINT_VENUES.some((p) => v.includes(p));
}

const OA_SELECT = [
  "id", "doi", "display_name", "publication_year", "type", "cited_by_count",
  "authorships", "primary_location", "best_oa_location", "open_access",
  "abstract_inverted_index", "is_retracted", "referenced_works", "ids",
  "language", "primary_topic",
].join(",");

const S2_FIELDS = [
  "title", "abstract", "year", "venue", "citationCount",
  "influentialCitationCount", "externalIds", "openAccessPdf", "tldr",
  "authors", "publicationTypes", "publicationDate", "s2FieldsOfStudy", "url",
].join(",");

// ------------------------------------------------------------- plumbing

const CONTACT = process.env.RESEARCH_CONTACT ?? "";
const UA = `deep-research-pipeline/1.0 (research agent${CONTACT ? `; ${CONTACT}` : ""})`;
const OA_KEY = process.env.OPENALEX_API_KEY ?? "";
const S2_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY ?? "";

let oaCost = 0;
let calls = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const warn = (m: string) => process.stderr.write(`  ${m}\n`);
export const redact = (u: string) => u.replace(/([?&]api_key=)[^&]*/gi, "$1<redacted>");

async function req(url: string, headers: Record<string, string> = {}, tries = 5): Promise<Response> {
  for (let i = 0; i < tries; i++) {
    let res: Response;
    try {
      calls++;
      res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      if (i === tries - 1) throw new Error(`network failure: ${redact(url)} (${e})`);
      await sleep(Math.min(2 ** i * 1000, 16_000));
      continue;
    }
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(2 ** i * 1000, 16_000);
      warn(`HTTP ${res.status} — backing off ${wait}ms (try ${i + 1}/${tries})`);
      await sleep(wait);
      continue;
    }
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${redact(url)}\n${body.slice(0, 400)}`);
  }
  throw new Error(`gave up after ${tries} tries: ${redact(url)}`);
}

async function getJSON(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await req(url, headers);
  const j = await res.json();
  if (j?.meta?.cost_usd) oaCost += Number(j.meta.cost_usd);
  return j;
}

const oaUrl = (path: string, params: Record<string, string | number | undefined>) => {
  const u = new URL(OPENALEX + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  if (OA_KEY) u.searchParams.set("api_key", OA_KEY);
  return u.toString();
};

// ------------------------------------------------------------ normalise

export function invertedToText(inv: Record<string, number[]> | null | undefined): string | null {
  if (!inv) return null;
  const pos: [number, string][] = [];
  for (const [w, ps] of Object.entries(inv)) for (const p of ps) pos.push([p, w]);
  if (!pos.length) return null;
  pos.sort((a, b) => a[0] - b[0]);
  return pos.map((p) => p[1]).join(" ");
}

export const cleanDoi = (d: string | null | undefined): string | null =>
  !d ? null : d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "").trim().toLowerCase() || null;

export const cleanArxiv = (a: string | null | undefined): string | null =>
  !a ? null : a.replace(/^https?:\/\/arxiv\.org\/abs\//i, "").replace(/^arxiv:/i, "").replace(/v\d+$/i, "").trim() || null;

const blank = (): Rec => ({
  id: null, title: "", authors: [], year: null, venue: null, doi: null, pmid: null,
  pmcid: null, arxiv: null, openalex: null, corpus_id: null, url: null, oa_url: null,
  abstract: null, tldr: null, citations: null, kind: "unknown", retracted: null,
  language: null, topic: null, referenced_works: [], source_api: "", query: null,
  metadata_at: null, found_by: [], anomalies: [],
});

const nowIso = () => new Date().toISOString().slice(0, 10);
const THIS_YEAR = new Date().getUTCFullYear();

/**
 * Flag records whose fields contradict each other. Upstream catalogues do
 * merge distinct works into one record, and the result looks authoritative:
 * real authors, real citation count, wrong title and year. Observed live in
 * OpenAlex — a record carrying the author list and 3,052 citations of a 2020
 * paper under the title and DOI of an unrelated 2026 preprint.
 *
 * Anything flagged here must be checked against the publisher's own page
 * before it is cited. These are heuristics, not verdicts.
 */
export function flagAnomalies(r: Rec): Rec {
  const a: string[] = [];
  if (!r.title) a.push("no-title");
  if (!r.authors.length) a.push("no-authors");
  if (!r.doi && !r.url && !r.oa_url) a.push("no-locator");
  if (r.retracted === true) a.push("RETRACTED");
  if (r.year && r.year > THIS_YEAR + 1) a.push(`implausible-year:${r.year}`);
  // A paper cannot accumulate hundreds of citations in its first months.
  // When it appears to, the record is usually two works merged.
  if (r.year && r.citations && r.year >= THIS_YEAR && r.citations > 300)
    a.push(`citations-year-mismatch:${r.citations}@${r.year}`);
  if (r.year && r.citations && r.year === THIS_YEAR - 1 && r.citations > 2000)
    a.push(`citations-year-mismatch:${r.citations}@${r.year}`);
  r.anomalies = a;
  return r;
}

export function fromOpenAlex(w: any, query: string | null): Rec {
  const r = blank();
  r.source_api = "openalex";
  r.query = query;
  r.title = w.display_name ?? w.title ?? "";
  r.authors = (w.authorships ?? []).map((a: any) => a?.author?.display_name).filter(Boolean);
  r.year = w.publication_year ?? null;
  r.venue = w.primary_location?.source?.display_name ?? null;
  r.doi = cleanDoi(w.doi ?? w.ids?.doi);
  r.pmid = w.ids?.pmid ? String(w.ids.pmid).split("/").pop()! : null;
  r.pmcid = w.ids?.pmcid ? String(w.ids.pmcid).split("/").pop()! : null;
  r.openalex = w.id ? String(w.id).split("/").pop()! : null;
  r.arxiv = r.doi?.startsWith("10.48550/arxiv.") ? r.doi.replace("10.48550/arxiv.", "") : null;
  r.url = w.primary_location?.landing_page_url ?? (w.doi ? `https://doi.org/${r.doi}` : null);
  r.oa_url = w.best_oa_location?.pdf_url ?? w.open_access?.oa_url ?? null;
  r.abstract = invertedToText(w.abstract_inverted_index);
  r.citations = w.cited_by_count ?? null;
  r.kind = w.type ?? "unknown";
  r.retracted = w.is_retracted ?? null;
  r.language = w.language ?? null;
  r.topic = w.primary_topic?.display_name ?? null;
  r.referenced_works = (w.referenced_works ?? []).map((x: string) => String(x).split("/").pop()!);
  r.metadata_at = r.abstract ? nowIso() : null;
  return r;
}

export function fromS2(p: any, query: string | null): Rec {
  const r = blank();
  r.source_api = "s2";
  r.query = query;
  r.title = p.title ?? "";
  r.authors = (p.authors ?? []).map((a: any) => a?.name).filter(Boolean);
  r.year = p.year ?? null;
  r.venue = p.venue ?? null;
  r.doi = cleanDoi(p.externalIds?.DOI);
  r.pmid = p.externalIds?.PubMed ? String(p.externalIds.PubMed) : null;
  r.pmcid = p.externalIds?.PubMedCentral ? String(p.externalIds.PubMedCentral) : null;
  r.arxiv = cleanArxiv(p.externalIds?.ArXiv);
  r.corpus_id = p.externalIds?.CorpusId ? String(p.externalIds.CorpusId) : null;
  r.url = p.url ?? (r.doi ? `https://doi.org/${r.doi}` : null);
  r.oa_url = p.openAccessPdf?.url ?? null;
  r.abstract = p.abstract ?? null;
  r.tldr = p.tldr?.text ?? null;
  r.citations = p.citationCount ?? null;
  r.kind = (p.publicationTypes ?? [])[0] ?? "unknown";
  r.metadata_at = r.abstract ? nowIso() : null;
  return r;
}

export function fromCrossref(w: any, query: string | null): Rec {
  const r = blank();
  r.source_api = "crossref";
  r.query = query;
  r.title = (w.title ?? [])[0] ?? "";
  r.authors = (w.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean);
  r.year = w.issued?.["date-parts"]?.[0]?.[0] ?? null;
  r.venue = (w["container-title"] ?? [])[0] ?? null;
  r.doi = cleanDoi(w.DOI);
  r.url = w.URL ?? (r.doi ? `https://doi.org/${r.doi}` : null);
  r.abstract = w.abstract ? String(w.abstract).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
  r.citations = w["is-referenced-by-count"] ?? null;
  r.kind = w.type ?? "unknown";
  r.referenced_works = (w.reference ?? []).map((x: any) => cleanDoi(x.DOI)).filter(Boolean) as string[];
  r.metadata_at = r.abstract ? nowIso() : null;
  return r;
}

export function fromEpmc(p: any, query: string | null): Rec {
  const r = blank();
  r.source_api = "europepmc";
  r.query = query;
  r.title = p.title ?? "";
  r.authors = p.authorString ? String(p.authorString).split(",").map((s: string) => s.trim()).filter(Boolean) : [];
  r.year = p.pubYear ? Number(p.pubYear) : null;
  r.venue = p.journalTitle ?? p.bookOrReportDetails?.publisher ?? null;
  r.doi = cleanDoi(p.doi);
  r.pmid = p.pmid ? String(p.pmid) : null;
  r.pmcid = p.pmcid ? String(p.pmcid) : null;
  r.url = r.doi ? `https://doi.org/${r.doi}` : p.pmid ? `https://europepmc.org/article/MED/${p.pmid}` : null;
  r.oa_url = p.inEPMC === "Y" && p.pmcid ? `https://europepmc.org/articles/${p.pmcid}` : null;
  r.abstract = p.abstractText ? String(p.abstractText).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
  r.citations = p.citedByCount ?? null;
  r.kind = p.pubType ?? "unknown";
  r.metadata_at = r.abstract ? nowIso() : null;
  return r;
}

// -------------------------------------------------------------- sources

export type SearchOpts = {
  q: string; limit: number; from?: number; to?: number;
  oa?: boolean; fulltext?: boolean; kind?: string; peerReviewed?: boolean;
};

/**
 * Request building is separated from request sending so the query each source
 * actually receives can be asserted without a network call. Every one of these
 * has been wrong at least once: a repeated Crossref `filter` parameter is an
 * HTTP 400 that the catch below turns into an empty result set and a warning,
 * which reads exactly like "this source has nothing" — a silent coverage hole.
 */
export function oaSearchFilter(o: SearchOpts): string[] {
  const f: string[] = [`${o.fulltext ? "default" : "title_and_abstract"}.search:${o.q}`, "is_retracted:false"];
  if (o.from && o.to) f.push(`publication_year:${o.from}-${o.to}`);
  else if (o.from) f.push(`publication_year:>${o.from - 1}`);
  else if (o.to) f.push(`publication_year:<${o.to + 1}`);
  if (o.oa) f.push("is_oa:true");
  if (o.kind) f.push(`type:${o.kind}`);
  if (o.peerReviewed) f.push(...OA_PEER_REVIEWED);
  return f;
}

export function s2SearchUrl(o: SearchOpts): string {
  const u = new URL(`${S2}/paper/search`);
  u.searchParams.set("query", o.q);
  u.searchParams.set("limit", String(Math.min(100, o.limit)));
  u.searchParams.set("fields", S2_FIELDS);
  if (o.from || o.to) u.searchParams.set("year", `${o.from ?? ""}-${o.to ?? ""}`);
  if (o.oa) u.searchParams.set("openAccessPdf", "");
  if (o.peerReviewed) u.searchParams.set("publicationTypes", "JournalArticle,Conference");
  return u.toString();
}

export function crossrefSearchUrl(o: SearchOpts): string {
  const u = new URL(`${CROSSREF}/works`);
  u.searchParams.set("query.bibliographic", o.q);
  u.searchParams.set("rows", String(Math.min(100, o.limit)));
  u.searchParams.set("select", "DOI,title,issued,container-title,author,is-referenced-by-count,URL,abstract,type");
  // Crossref takes ONE filter parameter, comma separated. Repeating it is a
  // 400, which is why these are collected before being set.
  const f: string[] = [];
  if (o.from) f.push(`from-pub-date:${o.from}-01-01`);
  if (o.to) f.push(`until-pub-date:${o.to}-12-31`);
  if (o.peerReviewed) f.push("type:journal-article", "type:proceedings-article");
  if (f.length) u.searchParams.set("filter", f.join(","));
  if (CONTACT) u.searchParams.set("mailto", CONTACT);
  return u.toString();
}

export function epmcSearchUrl(o: SearchOpts): string {
  let query = o.q;
  if (o.from || o.to) query += ` AND (PUB_YEAR:[${o.from ?? 1800} TO ${o.to ?? 2100}])`;
  if (o.oa) query += " AND OPEN_ACCESS:y";
  if (o.peerReviewed) query += " AND NOT SRC:PPR";  // PPR is Europe PMC's preprint corpus
  const u = new URL(`${EPMC}/search`);
  u.searchParams.set("query", query);
  u.searchParams.set("format", "json");
  u.searchParams.set("resultType", "core");
  u.searchParams.set("pageSize", String(Math.min(100, o.limit)));
  return u.toString();
}

async function searchOpenAlex(o: SearchOpts): Promise<Rec[]> {
  const filter = oaSearchFilter(o).join(",");
  const out: Rec[] = [];
  for (let page = 1; out.length < o.limit && page <= 100; page++) {
    const per = Math.min(100, o.limit - out.length);
    const j = await getJSON(oaUrl("/works", {
      filter, per_page: per, page, select: OA_SELECT, sort: "cited_by_count:desc",
    }));
    const rows = j.results ?? [];
    warn(`openalex: page ${page}, ${rows.length} rows of ${j.meta?.count ?? "?"} matching`);
    out.push(...rows.map((w: any) => fromOpenAlex(w, o.q)));
    if (rows.length < per) break;
  }
  return out;
}

async function searchS2(o: SearchOpts): Promise<Rec[]> {
  try {
    const j = await getJSON(s2SearchUrl(o), S2_KEY ? { "x-api-key": S2_KEY } : {});
    const rows = j.data ?? [];
    warn(`s2: ${rows.length} rows of ${j.total ?? "?"} matching`);
    return rows.map((p: any) => fromS2(p, o.q));
  } catch (e) {
    warn(`s2 unavailable (${String(e).slice(0, 120)})`);
    warn(S2_KEY ? "s2: key is set but the call still failed" : "s2: set SEMANTIC_SCHOLAR_API_KEY — the keyless tier 429s under load");
    return [];
  }
}

async function searchCrossref(o: SearchOpts): Promise<Rec[]> {
  try {
    const j = await getJSON(crossrefSearchUrl(o));
    const rows = j.message?.items ?? [];
    warn(`crossref: ${rows.length} rows of ${j.message?.["total-results"] ?? "?"} matching`);
    return rows.map((w: any) => fromCrossref(w, o.q));
  } catch (e) {
    warn(`crossref unavailable (${String(e).slice(0, 120)})`);
    return [];
  }
}

async function searchEpmc(o: SearchOpts): Promise<Rec[]> {
  try {
    const j = await getJSON(epmcSearchUrl(o));
    const rows = j.resultList?.result ?? [];
    warn(`europepmc: ${rows.length} rows of ${j.hitCount ?? "?"} matching`);
    return rows.map((p: any) => fromEpmc(p, o.q));
  } catch (e) {
    warn(`europepmc unavailable (${String(e).slice(0, 120)})`);
    return [];
  }
}

// ---------------------------------------------------------------- dedup

export function keysOf(r: Rec): string[] {
  const k: string[] = [];
  if (r.doi) k.push(`doi:${r.doi}`);
  if (r.pmid) k.push(`pmid:${r.pmid}`);
  if (r.pmcid) k.push(`pmcid:${r.pmcid}`);
  if (r.arxiv) k.push(`arxiv:${r.arxiv}`);
  if (r.openalex) k.push(`oa:${r.openalex}`);
  if (r.corpus_id) k.push(`s2:${r.corpus_id}`);
  const t = r.title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length > 15) k.push(`title:${t}|${r.year ?? "?"}`);
  return k;
}

function merge(a: Rec, b: Rec): Rec {
  const out: Rec = { ...a };
  for (const f of ["doi", "pmid", "pmcid", "arxiv", "openalex", "corpus_id", "url",
    "oa_url", "abstract", "tldr", "venue", "year", "topic", "language", "retracted"] as const) {
    if (out[f] === null || out[f] === undefined || out[f] === "") (out as any)[f] = (b as any)[f];
  }
  if (!out.title) out.title = b.title;
  if (b.authors.length > out.authors.length) out.authors = b.authors;
  if (b.referenced_works.length > out.referenced_works.length) out.referenced_works = b.referenced_works;
  out.citations = Math.max(out.citations ?? 0, b.citations ?? 0) || null;
  if (out.kind === "unknown") out.kind = b.kind;
  out.metadata_at = out.metadata_at ?? b.metadata_at;
  out.source_api = [...new Set([...out.source_api.split("+"), ...b.source_api.split("+")])].filter(Boolean).join("+");
  out.found_by = [...new Set([...out.found_by, ...b.found_by, a.query, b.query].filter(Boolean) as string[])];
  return out;
}

export function dedup(recs: Rec[]): { records: Rec[]; merged: number } {
  const byKey = new Map<string, number>();
  const kept: Rec[] = [];
  let merged = 0;
  for (const r of recs) {
    const ks = keysOf(r);
    let hit = -1;
    for (const k of ks) if (byKey.has(k)) { hit = byKey.get(k)!; break; }
    if (hit >= 0) {
      kept[hit] = merge(kept[hit], r);
      merged++;
      for (const k of keysOf(kept[hit])) byKey.set(k, hit);
    } else {
      const rec = { ...r, found_by: [...new Set([...r.found_by, r.query].filter(Boolean) as string[])] };
      kept.push(rec);
      for (const k of ks) byKey.set(k, kept.length - 1);
    }
  }
  kept.sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0));
  kept.forEach((r, i) => {
    r.id = `S${String(i + 1).padStart(3, "0")}`;
    flagAnomalies(r);
  });
  return { records: kept, merged };
}

// ------------------------------------------------------------ arg parse

/**
 * Every flag each command accepts, so a typo is an error with a suggestion
 * instead of a silently ignored argument. See args.ts.
 */
const FLAGS: Record<string, string[]> = {
  search: ["q", "source", "limit", "from", "to", "oa", "fulltext", "kind", "peer-reviewed", "out"],
  cites: ["id", "direction", "limit", "peer-reviewed", "out"],
  resolve: ["id", "out"],
  fetch: ["id", "out", "no-cache", "max-chars"],
  trend: ["q", "group", "fulltext"],
  dedup: ["in", "out"],
  verify: ["in", "limit"],
  doctor: ["offline", "json", "strict"],
};

/**
 * The last net under the API filters, applied to raw records -- before dedup, so
 * that a preprint merging with its published version cannot drag the venue of
 * the merged record down with it. Reports what it dropped: a coverage number
 * the reader of gate 2 needs.
 */
export function dropPreprints(recs: Rec[], on: boolean): Rec[] {
  if (!on) return recs;
  const kept = recs.filter((r) => !isPreprintVenue(r.venue));
  const dropped = recs.length - kept.length;
  if (dropped) warn(`--peer-reviewed: dropped ${dropped} record(s) on a preprint venue`);
  return kept;
}

const num = (v: unknown, d: number) => (v === undefined ? d : Number(v));
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

async function emit(records: Rec[], out: string | undefined, extra: Record<string, unknown> = {}) {
  const payload = {
    generated: new Date().toISOString(),
    count: records.length,
    api_calls: calls,
    openalex_cost_usd: Number(oaCost.toFixed(5)),
    ...extra,
    records,
  };
  const json = JSON.stringify(payload, null, 2);
  if (out) {
    await Bun.write(out, json);
    warn(`wrote ${records.length} records to ${out}`);
  } else {
    process.stdout.write(json + "\n");
  }
  const flagged = records.filter((r) => r.anomalies.length);
  if (flagged.length) {
    warn(`${flagged.length} record(s) have suspect metadata — verify against the publisher page before citing:`);
    for (const r of flagged.slice(0, 10)) {
      warn(`  ${r.id} [${r.anomalies.join(", ")}] ${r.title.slice(0, 60)}`);
    }
  }
  warn(`${calls} API calls, OpenAlex cost $${oaCost.toFixed(5)}`);
}

// -------------------------------------------------------------- commands

const HELP = `
scholar.ts — scholarly retrieval for deep-research-pipeline

  bun scholar.ts search  --q "<terms>" [--source openalex|s2|crossref|europepmc|all]
                         [--limit 50] [--from 2021] [--to 2026] [--oa]
                         [--fulltext] [--kind article|review] [--peer-reviewed]
                         [--out FILE]
      Keyword search. Default source openalex, default limit 50.
      Title+abstract scoped unless --fulltext (which is high recall, noisy).
      Always excludes retracted works. --source all runs every source and dedups.
      --peer-reviewed keeps only journal, conference and proceedings work with
      a DOI, dropping preprints (arXiv, bioRxiv, SSRN, …), theses and patents.
      It cuts hard -- measured 29,787 to 7,592 OpenAlex works on one query -- so
      say so at the coverage gate. Not the same as retraction filtering, which
      is always on.

  bun scholar.ts cites   --id <W… |DOI> --direction citing|references
                         [--limit 100] [--peer-reviewed] [--out FILE]
      Citation snowballing. 'citing' = works that cite it (forward).
      'references' = works it cites (backward, read off referenced_works
      then resolved; falls back to Crossref when OpenAlex has not indexed
      the reference list).

  bun scholar.ts resolve --id <DOI|arXiv|PMID|W…> [--out FILE]
      Normalise one identifier to a full record.

  bun scholar.ts fetch   --id <DOI|arXiv|PMID|W…|URL> [--out FILE]
                         [--no-cache] [--max-chars 400000]
      The text, not the metadata — what non-negotiable 1 actually requires.
      Routes, in order: shared cross-run cache, Europe PMC JATS, ar5iv HTML
      (arXiv), the OA copy from OpenAlex/S2, Unpaywall (needs
      RESEARCH_CONTACT). PDFs are converted with pdftotext when poppler is
      installed. Writes a markdown file ready for
      'ledger.ts mark-read --scope fulltext'. Exit 3 = no full text available,
      which is a fact about the source, not an error.

  bun scholar.ts trend   --q "<terms>" [--group publication_year]
      Cheap landscape analysis via OpenAlex group_by. Other useful groups:
      primary_topic.id, type, open_access.oa_status,
      authorships.institutions.id, language.

  bun scholar.ts dedup   --in a.json,b.json[,…] --out corpus.json
      Merge record sets. Precedence: DOI > PMID/PMCID > arXiv > OpenAlex/
      CorpusId > normalised title+year. Assigns stable S### ledger ids.

  bun scholar.ts verify  --in <corpus.json|ledger.json> [--limit 200]
      Re-request every DOI and URL; report what no longer resolves.

  bun scholar.ts doctor  [--offline] [--json] [--strict]
      Preflight, before a run spends its budget: bun, pdftotext (PDF-only
      sources are unreadable without it), which API keys are set, DRP_RUN_DIR,
      the shared cache and its format version, and whether OpenAlex/S2/Crossref/
      Europe PMC answer. Key values are never printed. Exit 1 only when no
      scholarly API is reachable at all — everything else is a warning to
      disclose at the scope gate.
      --strict also exits 1 on the checks that limit what the evidence base can
      be rather than how fast it is gathered: no pdftotext (non-negotiable 13
      blocks every figure in a PDF-only source) and no OpenAlex (no snowballing,
      no trend). Use it before a 'systematic' run, where both are mandatory.
      Missing API keys stay warnings under --strict; they cost throughput.

Environment (all optional)
  OPENALEX_API_KEY           10x daily budget, usage tracking
  SEMANTIC_SCHOLAR_API_KEY   strongly recommended; keyless tier 429s
  RESEARCH_CONTACT           email sent to Crossref/Unpaywall as etiquette,
                             and required for the Unpaywall fetch route
  DRP_CACHE_DIR              override the shared cross-run source cache
  DRP_RUN_DIR                default --dir for ledger.ts

Unknown flags are rejected with a suggestion. If a flag is not here, it does
not exist.
`;

async function cmdSearch(o: Record<string, string | boolean>) {
  const q = str(o.q);
  if (!q) throw new Error("--q is required");
  const opts: SearchOpts = {
    q, limit: num(o.limit, 50),
    from: o.from ? Number(o.from) : undefined,
    to: o.to ? Number(o.to) : undefined,
    oa: !!o.oa, fulltext: !!o.fulltext, kind: str(o.kind),
    peerReviewed: !!o["peer-reviewed"],
  };
  const src = str(o.source) ?? "openalex";
  const runners: Record<string, () => Promise<Rec[]>> = {
    openalex: () => searchOpenAlex(opts),
    s2: () => searchS2(opts),
    crossref: () => searchCrossref(opts),
    europepmc: () => searchEpmc(opts),
  };
  let recs: Rec[] = [];
  if (src === "all") {
    for (const r of Object.values(runners)) recs.push(...(await r()));
  } else {
    const r = runners[src];
    if (!r) throw new Error(`unknown --source ${src}`);
    recs = await r();
  }
  recs = dropPreprints(recs, !!opts.peerReviewed);
  const { records, merged } = dedup(recs);
  warn(`${recs.length} raw, ${merged} merged, ${records.length} unique`);
  await emit(records, str(o.out), { query: q, source: src, raw: recs.length, merged });
}

async function cmdCites(o: Record<string, string | boolean>) {
  const idRaw = str(o.id);
  if (!idRaw) throw new Error("--id is required");
  const dir = str(o.direction) ?? "citing";
  const limit = num(o.limit, 100);
  const peerReviewed = !!o["peer-reviewed"];
  const pr = peerReviewed ? `,${OA_PEER_REVIEWED.join(",")}` : "";
  const oaId = /^W\d+$/i.test(idRaw) ? idRaw : (await resolveOne(idRaw))?.openalex;
  if (!oaId) throw new Error(`could not resolve ${idRaw} to an OpenAlex work`);

  let recs: Rec[] = [];
  if (dir === "citing") {
    for (let page = 1; recs.length < limit && page <= 100; page++) {
      const per = Math.min(100, limit - recs.length);
      const j = await getJSON(oaUrl("/works", {
        filter: `cites:${oaId},is_retracted:false${pr}`, per_page: per, page,
        select: OA_SELECT, sort: "cited_by_count:desc",
      }));
      const rows = j.results ?? [];
      warn(`forward: page ${page}, ${rows.length} of ${j.meta?.count ?? "?"} citing works`);
      recs.push(...rows.map((w: any) => fromOpenAlex(w, `cites:${oaId}`)));
      if (rows.length < per) break;
    }
  } else if (dir === "references") {
    const w = await getJSON(oaUrl(`/works/${oaId}`, { select: "id,doi,display_name,referenced_works" }));
    const refs: string[] = (w.referenced_works ?? []).map((x: string) => String(x).split("/").pop()!);
    warn(`backward: ${refs.length} referenced_works on ${oaId}`);
    if (!refs.length) {
      warn("OpenAlex has no reference list for this work — trying Crossref");
      const doi = cleanDoi(w.doi);
      if (doi) {
        const j = await getJSON(`${CROSSREF}/works/${doi}`);
        const dois = (j.message?.reference ?? []).map((x: any) => cleanDoi(x.DOI)).filter(Boolean) as string[];
        warn(`crossref: ${dois.length} references`);
        for (const batch of chunk(dois.slice(0, limit), 50)) {
          const j2 = await getJSON(oaUrl("/works", {
            filter: `doi:${batch.join("|")}${pr}`, per_page: 100, select: OA_SELECT,
          }));
          recs.push(...(j2.results ?? []).map((x: any) => fromOpenAlex(x, `references:${oaId}`)));
        }
      }
    }
    for (const batch of chunk(refs.slice(0, limit), 50)) {
      const j = await getJSON(oaUrl("/works", {
        filter: `openalex_id:${batch.join("|")}${pr}`, per_page: 100, select: OA_SELECT,
      }));
      recs.push(...(j.results ?? []).map((x: any) => fromOpenAlex(x, `references:${oaId}`)));
    }
  } else {
    throw new Error("--direction must be citing or references");
  }
  const { records, merged } = dedup(dropPreprints(recs, peerReviewed));
  await emit(records, str(o.out), { seed: oaId, direction: dir, merged });
}

const chunk = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

async function resolveOne(idRaw: string): Promise<Rec | null> {
  const id = idRaw.trim();
  let path: string | null = null;
  if (/^W\d+$/i.test(id)) path = `/works/${id}`;
  else if (/^10\.\d{4,}\//.test(cleanDoi(id) ?? "")) path = `/works/doi:${cleanDoi(id)}`;
  else if (/^\d{7,8}$/.test(id)) path = `/works/pmid:${id}`;
  else if (/^\d{4}\.\d{4,5}/.test(cleanArxiv(id) ?? "")) path = `/works/doi:10.48550/arxiv.${cleanArxiv(id)}`;
  if (!path) throw new Error(`unrecognised identifier: ${id}`);
  try {
    const w = await getJSON(oaUrl(path, { select: OA_SELECT }));
    return fromOpenAlex(w, null);
  } catch (e) {
    warn(`openalex could not resolve ${id} (${String(e).slice(0, 100)})`);
    return null;
  }
}

async function cmdResolve(o: Record<string, string | boolean>) {
  const id = str(o.id);
  if (!id) throw new Error("--id is required");
  const r = await resolveOne(id);
  if (!r) throw new Error(`could not resolve ${id}`);
  const { records } = dedup([r]);
  await emit(records, str(o.out));
}

async function cmdTrend(o: Record<string, string | boolean>) {
  const q = str(o.q);
  if (!q) throw new Error("--q is required");
  const group = str(o.group) ?? "publication_year";
  const f = [`${o.fulltext ? "default" : "title_and_abstract"}.search:${q}`, "is_retracted:false"];
  const j = await getJSON(oaUrl("/works", { filter: f.join(","), group_by: group }));
  const buckets = (j.group_by ?? []).map((g: any) => ({ key: g.key_display_name ?? g.key, count: g.count }));
  process.stdout.write(JSON.stringify({
    query: q, group, total: j.meta?.count ?? null,
    buckets: buckets.slice(0, 60), openalex_cost_usd: Number(oaCost.toFixed(5)),
  }, null, 2) + "\n");
  warn(`${buckets.length} buckets, ${j.meta?.count ?? "?"} works total`);
}

async function cmdDedup(o: Record<string, string | boolean>) {
  const inArg = str(o.in);
  if (!inArg) throw new Error("--in is required (comma-separated files)");
  const recs: Rec[] = [];
  for (const f of inArg.split(",").map((s) => s.trim()).filter(Boolean)) {
    const j = JSON.parse(await Bun.file(f).text());
    const rows: Rec[] = j.records ?? j.sources ?? (Array.isArray(j) ? j : []);
    warn(`${f}: ${rows.length} records`);
    recs.push(...rows);
  }
  const { records, merged } = dedup(recs);
  warn(`${recs.length} raw, ${merged} merged, ${records.length} unique`);
  await emit(records, str(o.out), { inputs: inArg, raw: recs.length, merged });
}

/**
 * Verify that a record's locator points at something real.
 *
 * For DOIs this queries the DOI Handle API rather than following the DOI to
 * the publisher. Publishers routinely answer automated requests with 403,
 * which a naive checker reports as a dead link — a false negative that is
 * worse than no check at all. The Handle API is authoritative about whether
 * a DOI is registered and where it points, and never blocks.
 *
 * Outcomes are deliberately four-valued: only `dead` is a finding. `blocked`
 * and `unreachable` are inconclusive and must be reported as unverified
 * rather than counted as failures.
 */
type VerifyOutcome = "ok" | "dead" | "blocked" | "unreachable" | "no-locator";

async function checkDoi(doi: string): Promise<{ outcome: VerifyOutcome; http: number; target?: string }> {
  try {
    const res = await fetch(`https://doi.org/api/handles/${doi}`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000),
    });
    const j: any = await res.json().catch(() => null);
    if (res.ok && j?.responseCode === 1) {
      const target = (j.values ?? []).find((v: any) => v.type === "URL")?.data?.value;
      return { outcome: "ok", http: res.status, target };
    }
    if (res.status === 404 || j?.responseCode === 100) return { outcome: "dead", http: res.status };
    return { outcome: "unreachable", http: res.status };
  } catch {
    return { outcome: "unreachable", http: 0 };
  }
}

async function checkUrl(url: string): Promise<{ outcome: VerifyOutcome; http: number }> {
  try {
    // GET with a tiny Range rather than HEAD: many servers reject HEAD outright.
    const res = await fetch(url, {
      method: "GET", redirect: "follow",
      headers: { "User-Agent": UA, Range: "bytes=0-512", Accept: "text/html,application/pdf,*/*" },
      signal: AbortSignal.timeout(20_000),
    });
    const s = res.status;
    if (s >= 200 && s < 400) return { outcome: "ok", http: s };
    if (s === 401 || s === 403 || s === 429 || s === 999) return { outcome: "blocked", http: s };
    if (s === 404 || s === 410) return { outcome: "dead", http: s };
    return { outcome: "unreachable", http: s };
  } catch {
    return { outcome: "unreachable", http: 0 };
  }
}

async function cmdVerify(o: Record<string, string | boolean>) {
  const f = str(o.in);
  if (!f) throw new Error("--in is required");
  const j = JSON.parse(await Bun.file(f).text());
  const recs: Rec[] = j.records ?? j.sources ?? (Array.isArray(j) ? j : []);
  const rows = recs.slice(0, num(o.limit, 200));
  const details: any[] = [];
  const tally: Record<VerifyOutcome, number> = { ok: 0, dead: 0, blocked: 0, unreachable: 0, "no-locator": 0 };

  for (const r of rows) {
    let res: { outcome: VerifyOutcome; http: number; target?: string };
    let locator: string | null = null;
    if (r.doi) {
      locator = `https://doi.org/${r.doi}`;
      res = await checkDoi(r.doi);
    } else if (r.url || r.oa_url) {
      locator = (r.url ?? r.oa_url)!;
      res = await checkUrl(locator);
    } else {
      res = { outcome: "no-locator", http: 0 };
    }
    tally[res.outcome]++;
    details.push({
      id: r.id, title: r.title.slice(0, 70), locator,
      outcome: res.outcome, http: res.http,
      ...(res.target ? { registered_target: res.target } : {}),
      ...(r.anomalies.length ? { anomalies: r.anomalies } : {}),
    });
    await sleep(120);
  }

  const verified = tally.ok;
  const unverified = tally.blocked + tally.unreachable;
  process.stdout.write(JSON.stringify({
    checked: rows.length,
    ok: tally.ok, dead: tally.dead, blocked: tally.blocked,
    unreachable: tally.unreachable, no_locator: tally["no-locator"],
    note: "blocked and unreachable are inconclusive, not failures — report them as unverified",
    details,
  }, null, 2) + "\n");

  warn(`verify: ${verified}/${rows.length} confirmed, ${tally.dead} dead, ${unverified} inconclusive (${tally.blocked} blocked, ${tally.unreachable} unreachable), ${tally["no-locator"]} without a locator`);
  if (tally.dead) warn("dead locators must be corrected or flagged in the report — see 08-quality-gates.md §8.4");
  if (unverified) warn("inconclusive results belong in the audit's 'not verified' block, not in the pass count");
}

// ---------------------------------------------------------- full text

/**
 * Getting the text, not the metadata.
 *
 * The pipeline's first non-negotiable is that a source is only citable once
 * its text is on disk, and systematic mode demands full text for anything
 * included. Until this command existed the skill asked for that without
 * providing any way to get it: `search` returns an `oa_url` that is usually a
 * PDF, and the agent's page-fetch tool reads HTML.
 *
 * Route order, most faithful first:
 *   1. the shared cross-run cache            (free, no network)
 *   2. Europe PMC JATS full text             (clean structure, life sciences)
 *   3. arXiv via ar5iv HTML                  (preprints, no PDF conversion)
 *   4. publisher/repository OA copy          (OpenAlex best_oa_location, S2)
 *   5. Unpaywall                             (another OA copy, needs an email)
 * A PDF is converted with `pdftotext` when poppler is installed; when it is
 * not, the command says so and names the URL so the agent can fall back to
 * its own fetch tool rather than silently recording an abstract as full text.
 */
const MAX_TEXT_CHARS = 400_000;

const stripTags = (s: string) =>
  s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n").map((l) => l.trim()).join("\n")
    .trim();

/** JATS (Europe PMC) → text. Keeps section titles, drops the reference list. */
export function jatsToText(xml: string): string {
  const body = xml.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? xml;
  const cleaned = body
    .replace(/<ref-list[\s\S]*?<\/ref-list>/gi, " ")
    .replace(/<table-wrap[\s\S]*?<\/table-wrap>/gi, "\n[table omitted]\n")
    .replace(/<title>/gi, "\n\n## ").replace(/<\/title>/gi, "\n")
    .replace(/<\/(p|sec|abstract)>/gi, "\n\n");
  return stripTags(cleaned);
}

type FetchResult = { text: string; via: string; url: string | null };

async function tryEpmc(r: Rec): Promise<FetchResult | null> {
  let pmcid = r.pmcid ? String(r.pmcid).toUpperCase() : null;
  if (!pmcid && r.doi) {
    try {
      const q = `${EPMC}/search?query=DOI:%22${encodeURIComponent(r.doi)}%22&format=json&pageSize=1`;
      const j = await getJSON(q);
      pmcid = j?.resultList?.result?.[0]?.pmcid ?? null;
    } catch { /* fall through to the next route */ }
  }
  if (!pmcid) return null;
  try {
    const url = `${EPMC}/${pmcid}/fullTextXML`;
    const res = await req(url, { Accept: "application/xml" });
    const xml = await res.text();
    const text = jatsToText(xml);
    if (text.length < 1500) return null;         // XML stub, not an article
    return { text, via: `europepmc:${pmcid}`, url };
  } catch {
    return null;
  }
}

async function tryArxiv(r: Rec): Promise<FetchResult | null> {
  const id = r.arxiv ?? (r.doi?.match(/10\.48550\/arxiv\.(.+)$/i)?.[1] ?? null);
  if (!id) return null;
  const url = `https://ar5iv.labs.arxiv.org/html/${id}`;
  try {
    const res = await req(url, { Accept: "text/html" }, 3);
    const html = await res.text();
    const text = stripTags(html.replace(/<nav[\s\S]*?<\/nav>/gi, " "));
    if (text.length < 3000) return null;
    return { text, via: `ar5iv:${id}`, url };
  } catch {
    return null;
  }
}

async function tryUnpaywall(r: Rec): Promise<string | null> {
  if (!r.doi || !CONTACT) return null;
  try {
    const j = await getJSON(`https://api.unpaywall.org/v2/${encodeURIComponent(r.doi)}?email=${encodeURIComponent(CONTACT)}`);
    return j?.best_oa_location?.url_for_pdf ?? j?.best_oa_location?.url ?? null;
  } catch {
    return null;
  }
}

/** A PDF or HTML URL → text. PDFs need poppler's pdftotext on PATH. */
async function textFromUrl(url: string): Promise<FetchResult | null> {
  let res: Response;
  try {
    res = await req(url, { Accept: "text/html,application/pdf,*/*" }, 3);
  } catch (e) {
    warn(`could not fetch ${redact(url)} (${String(e).slice(0, 80)})`);
    return null;
  }
  const ct = res.headers.get("content-type") ?? "";
  const buf = new Uint8Array(await res.arrayBuffer());
  const isPdf = ct.includes("pdf") || (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46);

  if (!isPdf) {
    const text = stripTags(new TextDecoder().decode(buf));
    return text.length >= 1500 ? { text, via: "html", url } : null;
  }

  const bin = Bun.which("pdftotext");
  if (!bin) {
    warn(`${redact(url)} is a PDF and pdftotext is not on PATH — install poppler (winget install oschwartz10612.Poppler / brew install poppler / apt install poppler-utils), or read the PDF with your own page-fetch tool and write the text to the sources/ file yourself`);
    return null;
  }
  // Inside the run directory when there is one. A run that keeps its
  // intermediates together stays self-contained and resumable, and the old
  // fallback to "." dropped a PDF into whatever the working directory happened
  // to be — which on a read-only checkout is a failure with no explanation.
  const scratch = process.env.DRP_RUN_DIR
    ? `${process.env.DRP_RUN_DIR.replace(/[\\/]+$/, "")}/raw`
    : (process.env.TEMP ?? process.env.TMPDIR ?? ".");
  try { mkdirSync(scratch, { recursive: true }); } catch { /* fall through to the write, which reports it */ }
  const tmp = `${scratch}/drp-${Date.now()}.pdf`;
  await Bun.write(tmp, buf);
  try {
    const proc = Bun.spawnSync([bin, "-layout", "-q", tmp, "-"]);
    const text = new TextDecoder().decode(proc.stdout).replace(/\f/g, "\n\n").replace(/[ \t]+/g, " ").trim();
    return text.length >= 1500 ? { text, via: "pdftotext", url } : null;
  } finally {
    try { unlinkSync(tmp); } catch { /* leave it to the OS */ }
  }
}

async function cmdFetch(o: Record<string, string | boolean>) {
  const idRaw = str(o.id);
  if (!idRaw) throw new Error("--id is required (DOI, arXiv id, PMID, OpenAlex W-id, or a URL)");
  const outPath = str(o.out);
  const maxChars = num(o["max-chars"], MAX_TEXT_CHARS);
  const isUrl = /^https?:\/\//i.test(idRaw);

  let rec: Rec | null = null;
  if (!isUrl) {
    rec = await resolveOne(idRaw);
    if (!rec) warn(`could not resolve ${idRaw} as metadata — continuing with the identifier alone`);
  }
  const ident = rec ?? { ...blank(), url: isUrl ? idRaw : null, doi: isUrl ? null : cleanDoi(idRaw) };
  const key = cacheKey(ident);

  // 1. the cache
  if (!o["no-cache"]) {
    const hit = await readCache(key);
    if (hit) {
      if (outPath) { await Bun.write(outPath, hit); warn(`cache hit (${key}) → ${outPath}, no network call`); }
      else process.stdout.write(hit);
      return;
    }
  }

  const routes: (() => Promise<FetchResult | null>)[] = [];
  if (rec) {
    routes.push(() => tryEpmc(rec!));
    routes.push(() => tryArxiv(rec!));
    if (rec.oa_url) routes.push(() => textFromUrl(rec!.oa_url!));
    if (rec.url && rec.url !== rec.oa_url) routes.push(() => textFromUrl(rec!.url!));
    routes.push(async () => {
      const u = await tryUnpaywall(rec!);
      return u ? await textFromUrl(u) : null;
    });
  } else if (isUrl) {
    routes.push(() => textFromUrl(idRaw));
  }

  let got: FetchResult | null = null;
  for (const route of routes) {
    got = await route();
    if (got) break;
  }

  if (!got) {
    process.stderr.write(
      `scholar.ts: no full text obtained for ${idRaw}\n` +
      `  Tried: ${routes.length} route(s) (${rec?.oa_url ? "OA copy present" : "no OA copy in metadata"}${CONTACT ? "" : ", Unpaywall skipped — set RESEARCH_CONTACT"}).\n` +
      `  Options: read it with your own page-fetch tool and write the text to the sources/ file, or record the source as abstract-only\n` +
      `  ('mark-read --from-abstract --scope abstract'), which the audit will hold to context-only evidence.\n`,
    );
    process.exit(3);   // "understood, but there is no text" — distinct from a crash
  }

  const truncated = got.text.length > maxChars;
  const body = truncated ? `${got.text.slice(0, maxChars)}\n\n[truncated at ${maxChars} chars]` : got.text;
  const header = [
    `# ${rec?.title || idRaw}`,
    "",
    rec?.authors?.length ? `- authors: ${rec.authors.slice(0, 12).join("; ")}` : null,
    rec?.year ? `- year: ${rec.year}` : null,
    rec?.venue ? `- venue: ${rec.venue}` : null,
    rec?.doi ? `- doi: ${rec.doi}` : null,
    got.url ? `- text-from: ${got.url}` : null,
    `- via: ${got.via}`,
    `- fetched: ${nowIso()}`,
    `- scope: fulltext (${body.length} chars${truncated ? ", truncated" : ""})`,
    "",
    "## Full text",
    "",
  ].filter(Boolean).join("\n");
  const doc = `${header}\n${body}\n`;

  if (outPath) {
    await Bun.write(outPath, doc);
    warn(`wrote ${body.length} chars to ${outPath} (via ${got.via})`);
    warn(`now run: ledger.ts mark-read --dir <D> --source <S###> --scope fulltext`);
  } else {
    process.stdout.write(doc);
  }
  if (!o["no-cache"]) {
    const p = await writeCache(key, doc);
    if (p) warn(`shared cache updated: ${p}`);
  }
}

// ------------------------------------------------------------------ doctor

/**
 * Preflight. The strictest rules in this skill (non-negotiables 1 and 13: read
 * the text, and no figure without full text) depend on the weakest part of the
 * environment — an OA copy, a PDF converter, an API key that is not being rate
 * limited. Discovering at stage 8 that pdftotext was never installed means a
 * run's worth of searches, fetches, and agent turns is already spent.
 *
 * Every check is cheap and read-only. Keys are reported as set/not set; their
 * values are never printed.
 */
async function cmdDoctor(o: Record<string, string | boolean>) {
  type Check = {
    name: string; status: "ok" | "warn" | "fail"; detail: string;
    /**
     * True when this check, if it is not `ok`, stops the run from meeting the
     * pipeline's evidence standards rather than merely slowing it down. Only
     * these promote to a failure under `--strict`: a missing API key costs
     * throughput, a missing PDF converter costs non-negotiable 13.
     */
    blocks?: boolean;
  };
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], detail: string, blocks = false) =>
    checks.push({ name, status, detail, blocks });
  const strict = !!o.strict;

  add("bun", "ok", `${Bun.version} (${process.platform})`);

  const pdftotext = Bun.which("pdftotext");
  if (pdftotext) {
    let version = "";
    try {
      const p = Bun.spawnSync([pdftotext, "-v"]);
      version = (new TextDecoder().decode(p.stderr) + new TextDecoder().decode(p.stdout)).split(/\r?\n/)[0].trim();
    } catch { /* the path exists; the version line is a nicety */ }
    add("pdftotext", "ok", `${pdftotext}${version ? ` — ${version}` : ""}`);
  } else {
    add("pdftotext", "warn",
      "not on PATH — PDF-only sources cannot be converted, so 'fetch' will exit 3 on them and every figure they carry is blocked by non-negotiable 13. Install poppler (winget install oschwartz10612.Poppler / brew install poppler / apt install poppler-utils)",
      true);
  }

  add("OPENALEX_API_KEY", OA_KEY ? "ok" : "warn",
    OA_KEY ? "set — 10x daily budget" : "not set — works, but on the shared pool");
  add("SEMANTIC_SCHOLAR_API_KEY", S2_KEY ? "ok" : "warn",
    S2_KEY ? "set" : "not set — the keyless tier returns 429 under real load; --source s2 will be unreliable");
  add("RESEARCH_CONTACT", CONTACT ? "ok" : "warn",
    CONTACT ? "set" : "not set — Crossref etiquette, and the Unpaywall fetch route needs it");

  const cs = cacheStatus();
  add("shared cache", cs.supported ? "ok" : "warn",
    `${cs.entries} entr${cs.entries === 1 ? "y" : "ies"} · ${Math.round(cacheList().reduce((n, e) => n + e.bytes, 0) / 1024)} KB · ${cs.note} · ${cs.path}`);

  const runDir = process.env.DRP_RUN_DIR;
  add("DRP_RUN_DIR", runDir ? "ok" : "warn",
    runDir ? `${runDir} — ledger.ts --dir defaults to it` : "not set — pass --dir on every ledger.ts call");

  let reachable = 0, probed = 0;
  if (!o.offline) {
    const probes: [string, string][] = [
      ["OpenAlex", `${OPENALEX}/works?per-page=1&select=id`],
      ["Semantic Scholar", `${S2}/paper/search?query=test&limit=1&fields=title`],
      ["Crossref", `${CROSSREF}/works?rows=1&select=DOI`],
      ["Europe PMC", `${EPMC}/search?query=test&format=json&pageSize=1`],
    ];
    const results = await Promise.all(probes.map(async ([name, url]) => {
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": UA, Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        return { name, ok: res.ok, status: res.status, detail: `HTTP ${res.status} in ${Date.now() - t0}ms` };
      } catch (e) {
        return { name, ok: false, status: 0, detail: `unreachable after ${Date.now() - t0}ms (${e instanceof Error ? e.message : String(e)})` };
      }
    }));
    for (const r of results) {
      probed++;
      if (r.ok) reachable++;
      // A keyless 429 from Semantic Scholar is the documented behaviour of the
      // free tier, not a broken network: the host answered. Report it as the
      // capability limit it is, and count it as reachable so one throttled
      // service cannot read as "no network".
      const keylessThrottle = r.status === 429 && r.name === "Semantic Scholar" && !S2_KEY;
      if (keylessThrottle) {
        reachable++;
        add(`network: ${r.name}`, "warn", `${r.detail} — the keyless tier is being throttled; set SEMANTIC_SCHOLAR_API_KEY or plan on openalex + crossref + europepmc`);
      } else {
        // OpenAlex is the backbone: `cites` (snowballing) and `trend` exist
        // nowhere else, and systematic mode requires snowballing. The other
        // three are substitutable, so only this one blocks --strict.
        add(`network: ${r.name}`, r.ok ? "ok" : "fail", r.detail, r.name === "OpenAlex");
      }
    }
  } else {
    add("network", "warn", "skipped (--offline)");
  }

  const blocked = probed > 0 && reachable === 0;
  const blockers = checks.filter((c) => c.blocks && c.status !== "ok");
  const strictFail = strict && blockers.length > 0;

  if (o.json) {
    process.stdout.write(JSON.stringify({
      ok: !blocked && !strictFail,
      strict,
      warnings: checks.filter((c) => c.status === "warn").length,
      failures: checks.filter((c) => c.status === "fail").length,
      blockers: blockers.map((c) => c.name),
      checks,
    }, null, 2) + "\n");
  } else {
    process.stdout.write(`# Preflight — deep-research-pipeline${strict ? " (strict)" : ""}\n\n`);
    const mark = { ok: "ok  ", warn: "WARN", fail: "FAIL" } as const;
    for (const c of checks) {
      process.stdout.write(`${mark[c.status]}  ${c.name}: ${c.detail}${c.blocks && c.status !== "ok" ? "  [blocks --strict]" : ""}\n`);
    }
    const warns = checks.filter((c) => c.status === "warn");
    process.stdout.write(`\n${checks.filter((c) => c.status === "ok").length} ok · ${warns.length} warning(s) · ${checks.filter((c) => c.status === "fail").length} failure(s)\n`);
    if (blocked) {
      process.stdout.write(`\nNo scholarly API is reachable. Stage 2 cannot run; say so rather than falling back to web search alone and calling it a literature review.\n`);
    } else if (strictFail) {
      process.stdout.write(`\nStrict preflight failed on: ${blockers.map((c) => c.name).join(", ")}.\n`);
      process.stdout.write(`These limit what the evidence base can be, not just how fast it is gathered. Fix them, or drop --strict and disclose the limit at the scope gate — a 'systematic' run that cannot read PDFs is not a systematic run.\n`);
    } else if (warns.length) {
      process.stdout.write(`\nNothing here blocks the run. Report the warnings that limit it at the scope gate — an environment that cannot read PDFs changes what the evidence base can be.\n`);
      if (!strict && blockers.length) {
        process.stdout.write(`Planning a 'systematic' run? Re-run with --strict: ${blockers.map((c) => c.name).join(", ")} would fail it, and finding that out at stage 8 wastes the run.\n`);
      }
    }
  }
  if (blocked || strictFail) process.exit(1);
}

// ------------------------------------------------------------------ main

// Guarded so the pure helpers above can be imported by the tests without the
// CLI firing on import.
if (import.meta.main) {
const { cmd, o } = parseArgs(process.argv.slice(2));
try {
  validateFlags(cmd, o, FLAGS);
  switch (cmd) {
    case "search": await cmdSearch(o); break;
    case "cites": await cmdCites(o); break;
    case "resolve": await cmdResolve(o); break;
    case "fetch": await cmdFetch(o); break;
    case "trend": await cmdTrend(o); break;
    case "dedup": await cmdDedup(o); break;
    case "verify": await cmdVerify(o); break;
    case "doctor": await cmdDoctor(o); break;
    case "--help": case "-h": case "help": process.stdout.write(HELP); break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n${HELP}`);
      process.exit(2);
  }
} catch (e) {
  process.stderr.write(`scholar.ts: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
}
