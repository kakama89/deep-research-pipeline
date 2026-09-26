#!/usr/bin/env bun
/**
 * scholar.test.ts — the retrieval half, held still without a network.
 *
 * `ledger.test.ts` and `pipeline.test.ts` cover the ledger; until this file
 * existed the whole scholarly leg was tested only through `doctor --offline`.
 * That gap shipped a real bug: `searchCrossref` appended the `filter` parameter
 * once per clause, and Crossref answers a repeated `filter` with HTTP 400 —
 * which the catch turned into an empty result set and a warning, reading
 * exactly like "this source has nothing to say". A silent coverage hole in the
 * one stage the pipeline is proudest of.
 *
 * So the two things tested here are the two that fail quietly:
 *   - request building — what each catalogue is actually asked;
 *   - normalisation — what comes back becoming one schema dedup can span.
 *
 * The payload fixtures are trimmed real responses, captured 2026-09-03, keeping
 * the shapes that matter: OpenAlex's `ids.doi` as a full URL and its abstract
 * as a positional index, Crossref's title-as-array, Europe PMC's HTML-in-JSON
 * abstract and its missing `pmcid` when `inEPMC` is `N`.
 *
 *   bun test scripts/scholar.test.ts
 */

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  OA_PEER_REVIEWED, cleanArxiv, cleanDoi, crossrefSearchUrl, dedup, dropPreprints,
  epmcSearchUrl, flagAnomalies, fromCrossref, fromEpmc, fromOpenAlex, fromS2,
  invertedToText, isPreprintVenue, jatsToText, keysOf, oaSearchFilter, redact,
  s2SearchUrl, type Rec, type SearchOpts,
} from "./scholar.ts";

// ------------------------------------------------------------- fixtures

/** OpenAlex W4388778348 — "In-Context Retrieval-Augmented Language Models". */
const OA_WORK = {
  id: "https://openalex.org/W4388778348",
  doi: "https://doi.org/10.1162/tacl_a_00605",
  display_name: "In-Context Retrieval-Augmented Language Models",
  publication_year: 2023,
  type: "article",
  cited_by_count: 399,
  language: "en",
  is_retracted: false,
  ids: { openalex: "https://openalex.org/W4388778348", doi: "https://doi.org/10.1162/tacl_a_00605" },
  authorships: [
    { author: { id: "https://openalex.org/A5058640064", display_name: "Ori Ram", orcid: null } },
    { author: { id: "https://openalex.org/A5000000001", display_name: "Yoav Levine", orcid: null } },
  ],
  primary_location: {
    is_oa: true,
    landing_page_url: "https://doi.org/10.1162/tacl_a_00605",
    pdf_url: "https://direct.mit.edu/tacl/article-pdf/doi/10.1162/tacl_a_00605/2178834/tacl_a_00605.pdf",
    source: { id: "https://openalex.org/S2729999759", display_name: "Transactions of the Association for Computational Linguistics", type: "journal" },
  },
  best_oa_location: { pdf_url: "https://direct.mit.edu/tacl/article-pdf/doi/10.1162/tacl_a_00605/2178834/tacl_a_00605.pdf" },
  open_access: { is_oa: true, oa_status: "diamond", oa_url: "https://direct.mit.edu/tacl/article-pdf/doi/10.1162/tacl_a_00605/2178834/tacl_a_00605.pdf" },
  abstract_inverted_index: {
    "Abstract": [0], "Retrieval-Augmented": [1], "Language": [2], "Modeling": [3],
    "(RALM)": [4], "methods,": [5], "improve": [6], "performance.": [7],
  },
  primary_topic: { display_name: "Topic Modeling" },
  referenced_works: ["https://openalex.org/W2612690371", "https://openalex.org/W2912924812"],
};

/** Semantic Scholar, the same paper — deliberately, so dedup can be tested. */
const S2_PAPER = {
  paperId: "465471bb5bf1a945549d6291c2d23367966b4957",
  title: "In-Context Retrieval-Augmented Language Models",
  venue: "Transactions of the Association for Computational Linguistics",
  year: 2023,
  citationCount: 1119,
  externalIds: { ArXiv: "2302.00083v2", DBLP: "journals/corr/abs-2302-00083", DOI: "10.1162/tacl_a_00605", CorpusId: 256459451 },
  openAccessPdf: { url: "https://direct.mit.edu/tacl/article-pdf/doi/10.1162/tacl_a_00605/2178834/tacl_a_00605.pdf", status: "GOLD" },
  abstract: "Retrieval-Augmented Language Modeling improves performance.",
  tldr: { text: "Prepending retrieved documents helps without fine-tuning." },
  authors: [{ name: "Ori Ram" }, { name: "Yoav Levine" }, { name: "Itay Dalmedigos" }],
  publicationTypes: ["JournalArticle"],
};

/** Crossref 10.1145/3637528.3671470 — a proceedings paper, no abstract. */
const CR_WORK = {
  DOI: "10.1145/3637528.3671470",
  title: ["A Survey on RAG Meeting LLMs: Towards Retrieval-Augmented Large Language Models"],
  issued: { "date-parts": [[2024, 8, 24]] },
  "container-title": ["Proceedings of the 30th ACM SIGKDD Conference on Knowledge Discovery and Data Mining"],
  type: "proceedings-article",
  "is-referenced-by-count": 764,
  URL: "https://doi.org/10.1145/3637528.3671470",
  author: [
    { given: "Wenqi", family: "Fan", sequence: "first" },
    { given: "Yujuan", family: "Ding" },
    { family: "Consortium" },
  ],
  reference: [{ key: "e_1_3_2_1_1_1", DOI: "10.1162/TACL_A_00605" }, { key: "e_1_3_2_1_2_1" }],
};

/** Europe PMC MED/38743812 — abstract carries HTML, and `inEPMC` is "N". */
const EP_RESULT = {
  title: "The Capsular Polysaccharide Obstructs Wall Teichoic Acid Functions in Staphylococcus aureus.",
  authorString: "Lehmann E, van Dalen R, Gritsch L, Wolz C.",
  pubYear: "2024",
  journalTitle: "The Journal of Infectious Diseases",
  doi: "10.1093/infdis/jiae188",
  pmid: "38743812",
  inEPMC: "N",
  pubType: "journal article",
  citedByCount: 11,
  abstractText: "<h4>Background</h4>The cell envelope of  Staphylococcus aureus contains 2 major glycopolymers.",
};

const opts = (o: Partial<SearchOpts> = {}): SearchOpts => ({ q: "rag", limit: 50, ...o });

// ------------------------------------------------------- request building

describe("request building — what each catalogue is actually asked", () => {
  test("Crossref sends exactly one filter parameter", () => {
    // The regression this file was written for. Crossref answers a repeated
    // `filter` with 400, and the caller turns that into silence.
    const u = new URL(crossrefSearchUrl(opts({ from: 2021, to: 2026, peerReviewed: true })));
    expect(u.searchParams.getAll("filter")).toHaveLength(1);
    const f = u.searchParams.get("filter")!;
    expect(f).toContain("from-pub-date:2021-01-01");
    expect(f).toContain("until-pub-date:2026-12-31");
    expect(f).toContain("type:journal-article");
    expect(f).toContain("type:proceedings-article");
  });

  test("Crossref omits the filter parameter entirely when there is nothing to filter", () => {
    expect(new URL(crossrefSearchUrl(opts())).searchParams.has("filter")).toBe(false);
  });

  test("OpenAlex always excludes retracted work, flag or no flag", () => {
    expect(oaSearchFilter(opts())).toContain("is_retracted:false");
    expect(oaSearchFilter(opts({ peerReviewed: true }))).toContain("is_retracted:false");
  });

  test("OpenAlex scopes to title and abstract unless --fulltext", () => {
    expect(oaSearchFilter(opts())[0]).toBe("title_and_abstract.search:rag");
    expect(oaSearchFilter(opts({ fulltext: true }))[0]).toBe("default.search:rag");
  });

  test("OpenAlex year bounds: both, lower only, upper only", () => {
    expect(oaSearchFilter(opts({ from: 2021, to: 2026 }))).toContain("publication_year:2021-2026");
    expect(oaSearchFilter(opts({ from: 2021 }))).toContain("publication_year:>2020");
    expect(oaSearchFilter(opts({ to: 2026 }))).toContain("publication_year:<2027");
  });

  test("Europe PMC folds its filters into the query string", () => {
    const q = new URL(epmcSearchUrl(opts({ from: 2021, to: 2026, oa: true, peerReviewed: true }))).searchParams.get("query")!;
    expect(q).toContain("PUB_YEAR:[2021 TO 2026]");
    expect(q).toContain("OPEN_ACCESS:y");
    expect(q).toContain("NOT SRC:PPR");
  });

  test("Europe PMC supplies open year bounds rather than an open-ended range", () => {
    const q = new URL(epmcSearchUrl(opts({ from: 2021 }))).searchParams.get("query")!;
    expect(q).toContain("PUB_YEAR:[2021 TO 2100]");
  });

  test("Semantic Scholar asks for publication types only under the tier", () => {
    expect(new URL(s2SearchUrl(opts())).searchParams.has("publicationTypes")).toBe(false);
    expect(new URL(s2SearchUrl(opts({ peerReviewed: true }))).searchParams.get("publicationTypes"))
      .toBe("JournalArticle,Conference");
  });

  test("every source caps its page size at the API maximum", () => {
    expect(new URL(s2SearchUrl(opts({ limit: 5000 }))).searchParams.get("limit")).toBe("100");
    expect(new URL(crossrefSearchUrl(opts({ limit: 5000 }))).searchParams.get("rows")).toBe("100");
    expect(new URL(epmcSearchUrl(opts({ limit: 5000 }))).searchParams.get("pageSize")).toBe("100");
  });
});

// --------------------------------------------------------- normalisation

describe("normalisation — four catalogues into one schema", () => {
  test("OpenAlex: identifiers are stripped to bare form", () => {
    const r = fromOpenAlex(OA_WORK, "rag");
    expect(r.doi).toBe("10.1162/tacl_a_00605");        // not the https://doi.org/ URL
    expect(r.openalex).toBe("W4388778348");            // not the https://openalex.org/ URL
    expect(r.referenced_works).toEqual(["W2612690371", "W2912924812"]);
    expect(r.source_api).toBe("openalex");
  });

  test("OpenAlex: the abstract is rebuilt from its positional index", () => {
    const r = fromOpenAlex(OA_WORK, "rag");
    expect(r.abstract).toBe("Abstract Retrieval-Augmented Language Modeling (RALM) methods, improve performance.");
  });

  test("OpenAlex: an abstract is what stamps metadata_at — and it is not read_at", () => {
    expect(fromOpenAlex(OA_WORK, null).metadata_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fromOpenAlex({ ...OA_WORK, abstract_inverted_index: null }, null).metadata_at).toBeNull();
  });

  test("OpenAlex: venue, type, language and topic come off the nested objects", () => {
    const r = fromOpenAlex(OA_WORK, null);
    expect(r.venue).toBe("Transactions of the Association for Computational Linguistics");
    expect(r.kind).toBe("article");
    expect(r.language).toBe("en");
    expect(r.topic).toBe("Topic Modeling");
    expect(r.authors).toEqual(["Ori Ram", "Yoav Levine"]);
  });

  test("OpenAlex: an arXiv DOI yields the arXiv id", () => {
    const r = fromOpenAlex({ ...OA_WORK, doi: "https://doi.org/10.48550/arXiv.2312.10997" }, null);
    expect(r.doi).toBe("10.48550/arxiv.2312.10997");
    expect(r.arxiv).toBe("2312.10997");
  });

  test("Semantic Scholar: externalIds fan out, and the arXiv version suffix is dropped", () => {
    const r = fromS2(S2_PAPER, "rag");
    expect(r.doi).toBe("10.1162/tacl_a_00605");
    expect(r.arxiv).toBe("2302.00083");                // "2302.00083v2" in the payload
    expect(r.corpus_id).toBe("256459451");
    expect(r.tldr).toBe("Prepending retrieved documents helps without fine-tuning.");
    expect(r.kind).toBe("JournalArticle");
  });

  test("Crossref: title is an array, the year is buried in date-parts", () => {
    const r = fromCrossref(CR_WORK, "rag");
    expect(r.title).toContain("A Survey on RAG Meeting LLMs");
    expect(r.year).toBe(2024);
    expect(r.venue).toContain("SIGKDD");
    expect(r.kind).toBe("proceedings-article");
    expect(r.citations).toBe(764);
  });

  test("Crossref: an author without a given name still gets a name, and DOI-less references are dropped", () => {
    const r = fromCrossref(CR_WORK, null);
    expect(r.authors).toEqual(["Wenqi Fan", "Yujuan Ding", "Consortium"]);
    expect(r.referenced_works).toEqual(["10.1162/tacl_a_00605"]);   // lower-cased, the keyed-only entry gone
  });

  test("Europe PMC: HTML is stripped out of the abstract", () => {
    const r = fromEpmc(EP_RESULT, "staph");
    expect(r.abstract).toBe("Background The cell envelope of Staphylococcus aureus contains 2 major glycopolymers.");
    expect(r.abstract).not.toContain("<h4>");
  });

  test("Europe PMC: no OA link when the record is not in Europe PMC", () => {
    expect(fromEpmc(EP_RESULT, null).oa_url).toBeNull();
    expect(fromEpmc({ ...EP_RESULT, inEPMC: "Y", pmcid: "PMC123" }, null).oa_url)
      .toBe("https://europepmc.org/articles/PMC123");
  });

  test("Europe PMC: the year is a string upstream and a number here", () => {
    expect(fromEpmc(EP_RESULT, null).year).toBe(2024);
  });

  test("an empty payload normalises rather than throwing", () => {
    for (const f of [fromOpenAlex, fromS2, fromCrossref, fromEpmc]) {
      const r = f({}, null);
      expect(r.title).toBe("");
      expect(r.authors).toEqual([]);
      expect(r.doi).toBeNull();
    }
  });
});

// ------------------------------------------------------------ identifiers

describe("identifier cleaning", () => {
  test("a DOI is reduced to bare lower case however it arrives", () => {
    for (const v of ["https://doi.org/10.1/AB", "http://dx.doi.org/10.1/ab", "doi:10.1/Ab", " 10.1/aB "]) {
      expect(cleanDoi(v)).toBe("10.1/ab");
    }
    expect(cleanDoi(null)).toBeNull();
    expect(cleanDoi("")).toBeNull();
  });

  test("an arXiv id loses its prefix and version, and keeps its case", () => {
    for (const v of ["https://arxiv.org/abs/2312.10997", "arXiv:2312.10997", "2312.10997v3"]) {
      expect(cleanArxiv(v)).toBe("2312.10997");
    }
    expect(cleanArxiv("cs/0501001")).toBe("cs/0501001");
    expect(cleanArxiv(undefined)).toBeNull();
  });
});

// ------------------------------------------------------------- anomalies

describe("anomaly flags — a record that looks authoritative and is wrong", () => {
  const rec = (over: Partial<Rec>): Rec => flagAnomalies({
    ...fromOpenAlex(OA_WORK, null), ...over,
  });

  test("a clean record is flagged with nothing", () => {
    expect(rec({}).anomalies).toEqual([]);
  });

  test("missing title, authors and every locator each raise their own flag", () => {
    const r = rec({ title: "", authors: [], doi: null, url: null, oa_url: null });
    expect(r.anomalies).toEqual(["no-title", "no-authors", "no-locator"]);
  });

  test("a retraction is flagged loudly", () => {
    expect(rec({ retracted: true }).anomalies).toContain("RETRACTED");
  });

  test("a year past next year is implausible", () => {
    const far = new Date().getUTCFullYear() + 5;
    expect(rec({ year: far }).anomalies).toContain(`implausible-year:${far}`);
  });

  test("hundreds of citations in the current year means two works were merged", () => {
    const now = new Date().getUTCFullYear();
    expect(rec({ year: now, citations: 3052 }).anomalies.join()).toContain("citations-year-mismatch");
    expect(rec({ year: now, citations: 12 }).anomalies).toEqual([]);
  });
});

// ------------------------------------------------------------------ dedup

describe("dedup — identity across catalogues", () => {
  test("keys are emitted in precedence order: DOI first, title last", () => {
    const k = keysOf(fromS2(S2_PAPER, null));
    expect(k[0]).toBe("doi:10.1162/tacl_a_00605");
    expect(k.slice(1)).toContain("arxiv:2302.00083");
    expect(k.slice(1)).toContain("s2:256459451");
    expect(k[k.length - 1]).toStartWith("title:in context retrieval augmented");
  });

  test("a title key carries the year and ignores punctuation, case and accents", () => {
    const base = fromOpenAlex(OA_WORK, null);
    const a = keysOf({ ...base, doi: null, openalex: null, title: "Über Rétrieval: Augmented, Models!" });
    const b = keysOf({ ...base, doi: null, openalex: null, title: "uber retrieval augmented models" });
    expect(a[a.length - 1]).toBe(b[b.length - 1]);
  });

  test("a short title is not a key — it would collide", () => {
    const base = fromOpenAlex(OA_WORK, null);
    expect(keysOf({ ...base, doi: null, openalex: null, title: "A survey" })).toEqual([]);
  });

  test("the same paper from OpenAlex and Semantic Scholar merges into one record", () => {
    const { records, merged } = dedup([fromOpenAlex(OA_WORK, "q1"), fromS2(S2_PAPER, "q2")]);
    expect(merged).toBe(1);
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.source_api).toBe("openalex+s2");
    expect(r.found_by.sort()).toEqual(["q1", "q2"]);
    expect(r.openalex).toBe("W4388778348");                // only OpenAlex had it
    expect(r.arxiv).toBe("2302.00083");                    // only S2 had it
    expect(r.tldr).toBe("Prepending retrieved documents helps without fine-tuning.");
    expect(r.citations).toBe(1119);                        // the higher of the two
    expect(r.authors).toHaveLength(3);                     // the longer list wins
  });

  test("records are ranked by citations and given contiguous ids", () => {
    // Fed in ascending order on purpose: the ranking has to do the work.
    const { records } = dedup([fromOpenAlex(OA_WORK, null), fromCrossref(CR_WORK, null)]);
    expect(records.map((r) => r.id)).toEqual(["S001", "S002"]);
    expect(records.map((r) => r.citations)).toEqual([764, 399]);
  });

  test("dedup flags anomalies on the merged record, not on the inputs", () => {
    const broken = { ...fromOpenAlex(OA_WORK, null), title: "", authors: [] };
    expect(dedup([broken]).records[0].anomalies).toContain("no-title");
  });

  test("an empty input set is not an error", () => {
    expect(dedup([])).toEqual({ records: [], merged: 0 });
  });
});

// ------------------------------------------------------- peer-reviewed tier

describe("the peer-reviewed tier", () => {
  test("preprint venues are recognised, published ones are not", () => {
    for (const v of ["arXiv (Cornell University)", "bioRxiv", "SSRN Electronic Journal",
                     "Research Square (Research Square)", "ChemRxiv", "Zenodo"]) {
      expect(isPreprintVenue(v)).toBe(true);
    }
    for (const v of ["Nature", "Transactions of the Association for Computational Linguistics",
                     "Lecture Notes in Computer Science", "Proceedings of the IEEE",
                     "ACM Computing Surveys"]) {
      expect(isPreprintVenue(v)).toBe(false);
    }
  });

  test("a missing venue is not a preprint — absence of evidence is not evidence", () => {
    expect(isPreprintVenue(null)).toBe(false);
    expect(isPreprintVenue(undefined)).toBe(false);
    expect(isPreprintVenue("")).toBe(false);
  });

  test("the OpenAlex clause keeps conference literature", () => {
    // Dropping `conference-paper` or "book series" silently deletes the whole
    // LNCS/CCIS proceedings corpus — the largest venue in a filtered CS pull.
    const f = OA_PEER_REVIEWED.join(",");
    expect(f).toContain("conference-paper");
    expect(f).toContain("book series");
    expect(f).toContain("has_doi:true");
  });

  test("dropPreprints is inert unless the flag is on", () => {
    const recs = [{ ...fromOpenAlex(OA_WORK, null), venue: "arXiv (Cornell University)" }];
    expect(dropPreprints(recs, false)).toHaveLength(1);
    expect(dropPreprints(recs, true)).toHaveLength(0);
  });

  test("dropPreprints runs before dedup, so a merged record keeps its journal venue", () => {
    // If it ran after, the arXiv copy could win the merge and take the
    // published version down with it.
    const arxivCopy = { ...fromS2(S2_PAPER, null), venue: "arXiv (Cornell University)" };
    const { records } = dedup(dropPreprints([arxivCopy, fromOpenAlex(OA_WORK, null)], true));
    expect(records).toHaveLength(1);
    expect(records[0].venue).toBe("Transactions of the Association for Computational Linguistics");
  });
});

// --------------------------------------------------------- text and safety

describe("text extraction and safety", () => {
  test("JATS becomes readable text with its headings kept", () => {
    const xml = `<article><front><article-meta><abstract><p>We measured it.</p></abstract>
      </article-meta></front><body><sec><title>Methods</title><p>Ten subjects.</p></sec>
      <sec><title>Results</title><p>It worked.</p></sec></body></article>`;
    const t = jatsToText(xml);
    expect(t).toContain("Methods");
    expect(t).toContain("Ten subjects.");
    expect(t).toContain("It worked.");
    expect(t).not.toContain("<sec>");
  });

  test("an API key is never printed back in a URL", () => {
    expect(redact("https://api.openalex.org/works?api_key=SECRET&per_page=1"))
      .toBe("https://api.openalex.org/works?api_key=<redacted>&per_page=1");
    expect(redact("https://x/?a=1&API_KEY=SECRET")).not.toContain("SECRET");
  });

  test("an empty inverted index is null, not an empty string", () => {
    expect(invertedToText(null)).toBeNull();
    expect(invertedToText({})).toBeNull();
    expect(invertedToText({ b: [1], a: [0] })).toBe("a b");
  });
});

// ------------------------------------------------------------- the CLI

/**
 * The rest of this file is pure and offline. These three spawn, because the
 * flag table is only a contract if the process actually refuses: "a flag that
 * is not in --help does not exist" (00-contract.md, Tooling).
 */
const SCHOLAR = fileURLToPath(new URL("./scholar.ts", import.meta.url));
const cli = (...args: string[]) => {
  const p = Bun.spawnSync(["bun", SCHOLAR, ...args]);
  return { code: p.exitCode ?? -1, err: new TextDecoder().decode(p.stderr) };
};

describe("the flag table is a contract", () => {
  test("a near-miss flag is refused with a suggestion, and nothing is written", () => {
    const r = cli("search", "--q", "x", "--peer-review");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('did you mean "peer-reviewed"');
    expect(r.err).toContain("Nothing was written");
  });

  test("the tier is offered on search and cites, and nowhere else", () => {
    // `--limit 0` and a missing `--id` both stop before any request, so this
    // stays offline: what is under test is validateFlags, not the catalogues.
    expect(cli("search", "--q", "x", "--peer-reviewed", "--limit", "0").err).not.toContain("unknown flag");
    expect(cli("cites", "--peer-reviewed").err).toBe("scholar.ts: --id is required\n");
    expect(cli("fetch", "--id", "x", "--peer-reviewed").err).toContain("unknown flag");
    expect(cli("trend", "--q", "x", "--peer-reviewed").err).toContain("unknown flag");
  });

  test("--help lists it, since that is where the contract is published", () => {
    const p = Bun.spawnSync(["bun", SCHOLAR, "--help"]);
    expect(new TextDecoder().decode(p.stdout)).toContain("--peer-reviewed");
  });
});
