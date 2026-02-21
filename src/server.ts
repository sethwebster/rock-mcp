#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { db, STALE_THRESHOLD_MS, type Page, type Source } from "./db.js";
import { crawlSource, searchDocs, normalizeUrl } from "./crawler.js";

// --- In-memory crawl job tracker ---
type CrawlJob = {
  sourceId: number;
  url: string;
  status: "running" | "done" | "error";
  startedAt: number;
  pagesIndexed?: number;
  error?: string;
};
const crawlJobs = new Map<number, CrawlJob>();

function startCrawlJob(source: Source, maxDepth: number, maxPages: number) {
  const job: CrawlJob = {
    sourceId: source.id,
    url: source.url,
    status: "running",
    startedAt: Date.now(),
  };
  crawlJobs.set(source.id, job);

  // Persist updated crawl settings
  db.prepare("UPDATE sources SET crawl_depth=?, max_pages=? WHERE id=?").run(
    maxDepth,
    maxPages,
    source.id
  );

  crawlSource(source, { maxDepth, maxPages })
    .then((count) => {
      job.status = "done";
      job.pagesIndexed = count;
    })
    .catch((err: unknown) => {
      job.status = "error";
      job.error = String(err);
      db.prepare("UPDATE sources SET status=? WHERE id=?").run("error", source.id);
    });
}

function isStale(source: Source): boolean {
  if (!source.last_crawled_at) return true;
  return Date.now() - source.last_crawled_at > STALE_THRESHOLD_MS;
}

function pageCountFor(sourceId: number): number {
  return (
    db.prepare("SELECT COUNT(*) as c FROM pages WHERE source_id = ?").get(sourceId) as {
      c: number;
    }
  ).c;
}

// --- Tool definitions ---
const tools: Tool[] = [
  {
    name: "add_docs_url",
    description: [
      "Crawl and index a documentation URL so it can be searched.",
      "WHEN TO CALL: Call this proactively whenever the user shares any URL that looks like documentation, a library reference, an API guide, a README, or a framework site — even if they don't explicitly ask you to index it.",
      "Triggers: 'here is the link', 'here are the docs', 'this is the reference', 'check out <url>', or any bare URL in a technical context.",
      "Crawling is async — call it immediately and then proceed to answer using search_docs. Do not wait for crawling to finish.",
      "Use max_depth=1 for a single page, max_depth=2 (default) for a docs site, max_depth=3 for large sites with many sub-sections.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to crawl" },
        max_depth: {
          type: "number",
          description: "Link-hops deep to crawl (default: 2, max: 4). Use 1 for a single page, 3+ for large sites.",
          default: 2,
        },
        max_pages: {
          type: "number",
          description: "Max pages to index (default: 50, max: 200). Increase for comprehensive coverage.",
          default: 50,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "search_docs",
    description: [
      "Full-text search across all indexed documentation.",
      "WHEN TO CALL: Use this before answering any technical question about a library, API, or framework — especially if the user has previously shared a docs link.",
      "Always search before saying you don't know something. Results include titles, summaries, topic tags, and excerpts.",
      "Stale sources (>24h since last crawl) are flagged in results — suggest recrawl_source if accuracy matters.",
      "After getting results, use get_page for full content or expand_topic to go deeper on a specific subject.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query — use natural language or key terms" },
        limit: {
          type: "number",
          description: "Max results (default: 5, max: 20)",
          default: 5,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_page",
    description: [
      "Retrieve the indexed content of a specific page by URL.",
      "WHEN TO CALL: When a search result looks relevant but the excerpt isn't enough to answer the question. Use the URL from search_docs results.",
      "Use the 'section' param to jump directly to a heading (e.g. section='ios 26 features') instead of paging through chunks.",
      "Content is returned in chunks (default 4000 chars). Check has_more and increment chunk to read further.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Exact page URL from search_docs results" },
        section: { type: "string", description: "Optional heading to jump to (e.g. 'ios 26 features'). Returns content starting at that heading." },
        chunk: { type: "number", description: "Chunk index (default: 0). Ignored when section is provided.", default: 0 },
        chunk_size: { type: "number", description: "Characters per chunk (default: 4000, max: 8000)", default: 4000 },
      },
      required: ["url"],
    },
  },
  {
    name: "expand_topic",
    description: [
      "Find all indexed pages covering a specific topic or keyword.",
      "WHEN TO CALL: When search_docs returns relevant results but you want more comprehensive coverage of a subject, or when the user says 'tell me more about X', 'I want to know more about X', or 'go deeper on X'.",
      "Uses the heading/topic index first (fast), then falls back to full-text search.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic or keyword to explore" },
        source_url: {
          type: "string",
          description: "Optional: restrict results to pages from this domain",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "list_sources",
    description: [
      "List all indexed documentation sources with crawl status, page counts, and staleness.",
      "WHEN TO CALL: When the user asks what docs are available, or to check if a source is already indexed before calling add_docs_url.",
    ].join(" "),
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "recrawl_source",
    description: [
      "Re-crawl a source to pick up updates. Reuses original depth/page settings.",
      "WHEN TO CALL: When search_docs flags a source as stale (>24h), or when the user says the docs may have changed, or after a library version update.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Source URL to refresh" },
      },
      required: ["url"],
    },
  },
  {
    name: "get_crawl_status",
    description: "Check crawl progress for a source. Use after add_docs_url if the user asks whether indexing is done.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Source URL" },
      },
      required: ["url"],
    },
  },
  {
    name: "delete_source",
    description:
      "Remove a documentation source and all its indexed pages from the database.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Source URL to delete" },
      },
      required: ["url"],
    },
  },
];

// --- Zod schemas ---
const AddDocsUrlSchema = z.object({
  url: z.string().url(),
  max_depth: z.number().int().min(0).max(4).default(2),
  max_pages: z.number().int().min(1).max(200).default(50),
});

const SearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5),
});

const GetPageSchema = z.object({
  url: z.string().url(),
  section: z.string().optional(),
  chunk: z.number().int().min(0).default(0),
  chunk_size: z.number().int().min(500).max(8000).default(4000),
});

const ExpandTopicSchema = z.object({
  topic: z.string().min(1),
  source_url: z.string().optional(),
});

const UrlSchema = z.object({ url: z.string().url() });

// --- Utilities ---

/** Safely parse topics JSON stored in DB. Returns [] on any corruption. */
function safeParseTopics(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Escape LIKE special characters (%, _) in a user-supplied string. */
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// --- Handlers ---
function handleAddDocsUrl(args: unknown) {
  const { url, max_depth, max_pages } = AddDocsUrlSchema.parse(args);
  const normalized = normalizeUrl(url);

  let source = db.prepare("SELECT * FROM sources WHERE url = ?").get(normalized) as
    | Source
    | undefined;

  if (!source) {
    db.prepare(
      "INSERT INTO sources (url, added_at, crawl_depth, max_pages, status) VALUES (?, ?, ?, ?, ?)"
    ).run(normalized, Date.now(), max_depth, max_pages, "pending");
    source = db.prepare("SELECT * FROM sources WHERE url = ?").get(normalized) as Source;
  }

  const existingJob = crawlJobs.get(source.id);
  if (existingJob?.status === "running") {
    return {
      message: `Already crawling ${url}. Use get_crawl_status to check progress.`,
      source_id: source.id,
      status: "crawling",
    };
  }

  startCrawlJob(source, max_depth, max_pages);

  return {
    message: `Crawling started for ${url} (depth: ${max_depth}, max: ${max_pages} pages). You can search_docs now — results will grow as pages index.`,
    source_id: source.id,
    status: "crawling",
  };
}

function handleSearchDocs(args: unknown) {
  const { query, limit } = SearchSchema.parse(args);
  const pages = searchDocs(query, limit);

  // Collect stale source warnings
  const staleSources: string[] = [];
  const allSources = db.prepare("SELECT * FROM sources").all() as Source[];
  for (const s of allSources) {
    if (s.status === "ready" && isStale(s)) staleSources.push(s.url);
  }

  if (pages.length === 0) {
    return {
      message: "No results found. Add documentation with add_docs_url.",
      results: [],
      stale_sources: staleSources,
    };
  }

  // Build snippet-style excerpts: find where query terms appear, show context around first hit
  const firstTerm = query.trim().split(/\s+/).find((t) => t.length > 2) ?? query.trim();
  const ids = pages.map((p) => p.id);
  const excerptRows = ids.length
    ? (db
        .prepare(
          `SELECT id,
            CASE
              WHEN instr(lower(content), lower(?)) > 0
              THEN substr(content, max(1, instr(lower(content), lower(?)) - 80), 500)
              ELSE substr(content, 1, 500)
            END as excerpt
           FROM pages WHERE id IN (${ids.map(() => "?").join(",")})`
        )
        .all(firstTerm, firstTerm, ...ids) as { id: number; excerpt: string }[])
    : [];
  const excerptMap = new Map(excerptRows.map((r) => [r.id, r.excerpt]));

  return {
    query,
    results: pages.map((p) => {
      return {
        url: p.url,
        title: p.title,
        summary: p.summary?.slice(0, 200),
        topics: safeParseTopics(p.topics).slice(0, 8),
        excerpt: excerptMap.get(p.id) ?? "",
      };
    }),
    total: pages.length,
    stale_sources: staleSources.length ? staleSources : undefined,
    tip: "Use get_page for full content, expand_topic to go deeper, recrawl_source to refresh stale sources.",
  };
}

function handleGetPage(args: unknown) {
  const { url, section, chunk, chunk_size } = GetPageSchema.parse(args);
  const normalized = normalizeUrl(url);

  const meta = db
    .prepare("SELECT id, url, title, topics, crawled_at, length(content) as content_len FROM pages WHERE url = ?")
    .get(normalized) as (Omit<Page, "content" | "summary" | "content_hash" | "depth" | "parent_url" | "source_id"> & { content_len: number }) | undefined;
  if (!meta) return { error: `Not found: ${normalized}. It may not have been crawled yet.` };

  const totalChunks = Math.ceil(meta.content_len / chunk_size);

  let offset = chunk * chunk_size;
  let sectionFound: boolean | undefined;

  if (section) {
    // Find the heading in content and jump to it
    const contentRow = db
      .prepare("SELECT content FROM pages WHERE id = ?")
      .get(meta.id) as { content: string };
    const lower = contentRow.content.toLowerCase();
    const sectionLower = section.toLowerCase();
    // Look for markdown heading containing the section text
    const headingPattern = new RegExp(`^#{1,4}[^\\n]*${sectionLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "im");
    const match = headingPattern.exec(contentRow.content);
    if (match) {
      offset = match.index;
      sectionFound = true;
    } else {
      // Fallback: plain text search
      const pos = lower.indexOf(sectionLower);
      if (pos !== -1) {
        offset = Math.max(0, pos - 50);
        sectionFound = true;
      } else {
        sectionFound = false;
      }
    }
  }

  // Guard against out-of-bounds chunk requests — return a clear error instead of
  // silently returning empty content, which gives the LLM no signal.
  if (offset >= meta.content_len && meta.content_len > 0) {
    return {
      error: `Chunk ${chunk} is out of range. This page has ${totalChunks} chunk(s) (0–${totalChunks - 1}).`,
      total_chunks: totalChunks,
    };
  }

  const row = db
    .prepare("SELECT substr(content, ?, ?) as slice FROM pages WHERE id = ?")
    .get(offset + 1, chunk_size, meta.id) as { slice: string };

  const currentChunk = Math.floor(offset / chunk_size);

  return {
    url: meta.url,
    title: meta.title,
    topics: safeParseTopics(meta.topics).slice(0, 12),
    crawled_at: new Date(meta.crawled_at).toISOString(),
    section_found: sectionFound,
    chunk: currentChunk,
    total_chunks: totalChunks,
    content: row.slice,
    has_more: offset + chunk_size < meta.content_len,
  };
}

function handleExpandTopic(args: unknown) {
  const { topic, source_url } = ExpandTopicSchema.parse(args);

  let pages: Page[];
  // Escape % and _ so user input doesn't become LIKE wildcards
  const topicPattern = `%${escapeLike(topic.toLowerCase())}%`;

  const cols = "p.id, p.source_id, p.url, p.title, p.summary, p.topics, p.crawled_at, p.content_hash, p.depth";
  if (source_url) {
    // Filter by source_id (exact match) rather than a LIKE on URL.
    // The old LIKE '%domain%' approach falsely matched short domains (go.com matched cargo.com)
    // and broke on domains containing _ (treated as single-char wildcard).
    const src = db.prepare("SELECT id FROM sources WHERE url = ?").get(normalizeUrl(source_url)) as { id: number } | undefined;
    if (src) {
      pages = db
        .prepare(
          `SELECT DISTINCT ${cols} FROM pages p
           INNER JOIN topic_index t ON t.page_id = p.id
           WHERE LOWER(t.topic) LIKE ? ESCAPE '\\' AND p.source_id = ?
           ORDER BY t.relevance DESC LIMIT 10`
        )
        .all(topicPattern, src.id) as Page[];
    } else {
      pages = [];
    }
  } else {
    pages = db
      .prepare(
        `SELECT DISTINCT ${cols} FROM pages p
         INNER JOIN topic_index t ON t.page_id = p.id
         WHERE LOWER(t.topic) LIKE ? ESCAPE '\\'
         ORDER BY t.relevance DESC LIMIT 10`
      )
      .all(topicPattern) as Page[];
  }

  if (pages.length === 0) pages = searchDocs(topic, 5);

  if (pages.length === 0) {
    return {
      message: `No content for "${topic}". Add more docs with add_docs_url.`,
      pages: [],
    };
  }

  // Fetch snippet around where the topic heading appears in each page
  const topicLower = topic.toLowerCase();
  return {
    topic,
    pages: pages.map((p) => {
      const row = db
        .prepare(
          `SELECT CASE
            WHEN instr(lower(content), ?) > 0
            THEN substr(content, max(1, instr(lower(content), ?) - 20), 600)
            ELSE substr(content, 1, 300)
           END as snippet
           FROM pages WHERE id = ?`
        )
        .get(topicLower, topicLower, p.id) as { snippet: string } | undefined;
      return {
        url: p.url,
        title: p.title,
        summary: p.summary?.slice(0, 150),
        topics: safeParseTopics(p.topics).slice(0, 6),
        snippet: row?.snippet ?? "",
      };
    }),
  };
}

function handleListSources() {
  const sources = db.prepare("SELECT * FROM sources ORDER BY added_at DESC").all() as Source[];

  return sources.map((s) => {
    const job = crawlJobs.get(s.id);
    return {
      id: s.id,
      url: s.url,
      title: s.title,
      status: job?.status === "running" ? "crawling" : s.status,
      pages_indexed: pageCountFor(s.id),
      last_crawled: s.last_crawled_at ? new Date(s.last_crawled_at).toISOString() : null,
      stale: s.status === "ready" && isStale(s),
    };
  });
}

function handleRecrawlSource(args: unknown) {
  const { url } = UrlSchema.parse(args);
  const normalized = normalizeUrl(url);
  const source = db.prepare("SELECT * FROM sources WHERE url = ?").get(normalized) as
    | Source
    | undefined;
  if (!source) return { error: `Not found: ${normalized}. Add it first with add_docs_url.` };

  if (crawlJobs.get(source.id)?.status === "running") {
    return { message: `Already crawling ${url}.` };
  }

  startCrawlJob(source, source.crawl_depth, source.max_pages);
  return { message: `Re-crawling ${url}. Use get_crawl_status to check progress.` };
}

function handleGetCrawlStatus(args: unknown) {
  const { url } = UrlSchema.parse(args);
  const normalized = normalizeUrl(url);
  const source = db.prepare("SELECT * FROM sources WHERE url = ?").get(normalized) as
    | Source
    | undefined;
  if (!source) return { error: `Not found: ${normalized}.` };

  const job = crawlJobs.get(source.id);
  return {
    url: source.url,
    status: job?.status ?? source.status,
    pages_indexed: pageCountFor(source.id),
    pages_this_run: job?.pagesIndexed,
    started_at: job ? new Date(job.startedAt).toISOString() : null,
    last_crawled: source.last_crawled_at ? new Date(source.last_crawled_at).toISOString() : null,
    stale: source.status === "ready" && isStale(source),
    error: job?.error,
  };
}

function handleDeleteSource(args: unknown) {
  const { url } = UrlSchema.parse(args);
  const normalized = normalizeUrl(url);
  const source = db.prepare("SELECT * FROM sources WHERE url = ?").get(normalized) as
    | Source
    | undefined;
  if (!source) return { error: `Not found: ${normalized}.` };

  if (crawlJobs.get(source.id)?.status === "running") {
    return { error: `Cannot delete ${normalized} while it is being crawled. Wait for crawl to finish.` };
  }

  const pages = pageCountFor(source.id);
  db.prepare("DELETE FROM sources WHERE id = ?").run(source.id);
  crawlJobs.delete(source.id);

  return { message: `Deleted ${url} and ${pages} indexed pages.` };
}

// --- MCP Server ---
const server = new Server(
  { name: "rock-mcp", version: "0.5.0" },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result: unknown;
    switch (name) {
      case "add_docs_url":     result = handleAddDocsUrl(args); break;
      case "search_docs":      result = handleSearchDocs(args); break;
      case "get_page":         result = handleGetPage(args); break;
      case "expand_topic":     result = handleExpandTopic(args); break;
      case "list_sources":     result = handleListSources(); break;
      case "recrawl_source":   result = handleRecrawlSource(args); break;
      case "get_crawl_status": result = handleGetCrawlStatus(args); break;
      case "delete_source":    result = handleDeleteSource(args); break;
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

// Expose indexed sources as MCP Resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const sources = db.prepare("SELECT * FROM sources WHERE status = 'ready'").all() as Source[];
  return {
    resources: sources.map((s) => ({
      uri: `rock-mcp://source/${encodeURIComponent(s.url)}`,
      name: s.title ?? s.url,
      description: `${pageCountFor(s.id)} pages indexed from ${s.url}`,
      mimeType: "text/plain",
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const match = uri.match(/^rock-mcp:\/\/source\/(.+)$/);
  if (!match) return { contents: [{ uri, mimeType: "text/plain", text: "Invalid URI" }] };

  const sourceUrl = decodeURIComponent(match[1]);
  const source = db.prepare("SELECT * FROM sources WHERE url = ?").get(sourceUrl) as
    | Source
    | undefined;
  if (!source) return { contents: [{ uri, mimeType: "text/plain", text: "Source not found" }] };

  const pages = db
    .prepare("SELECT url, title, summary, topics FROM pages WHERE source_id = ? ORDER BY depth, url")
    .all(source.id) as Pick<Page, "url" | "title" | "summary" | "topics">[];

  const text = [
    `# ${source.title ?? sourceUrl}`,
    `Source: ${sourceUrl}`,
    `Pages: ${pages.length}`,
    `Last crawled: ${source.last_crawled_at ? new Date(source.last_crawled_at).toISOString() : "never"}`,
    "",
    "## Indexed Pages",
    ...pages.map((p) => {
      const topics = safeParseTopics(p.topics).slice(0, 5).join(", ");
      return `- [${p.title ?? p.url}](${p.url})${topics ? ` — ${topics}` : ""}`;
    }),
  ].join("\n");

  return { contents: [{ uri, mimeType: "text/plain", text }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
