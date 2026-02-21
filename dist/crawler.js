import { createHash } from "crypto";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { db } from "./db.js";
const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
});
// Remove script/style noise
turndown.remove(["script", "style", "nav", "footer", "aside"]);
const CRAWL_CONCURRENCY = 5;
const CRAWL_DELAY_MS = 200;
const MAX_CONTENT_LENGTH = 50_000;
export async function searchWeb(query, limit = 10) {
    const encoded = encodeURIComponent(query);
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}&kl=en-us`, {
        headers: {
            "User-Agent": "Mozilla/5.0 (compatible; rock-mcp/0.5 documentation indexer)",
            "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok)
        throw new Error(`DuckDuckGo search failed: ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];
    $(".result__body").each((_, el) => {
        if (results.length >= limit)
            return false;
        const titleEl = $(el).find(".result__title a");
        const snippetEl = $(el).find(".result__snippet");
        const rawHref = titleEl.attr("href") ?? "";
        // DDG wraps links — extract uddg= param if present
        let url = rawHref;
        try {
            const u = new URL(rawHref.startsWith("http") ? rawHref : `https://duckduckgo.com${rawHref}`);
            url = u.searchParams.get("uddg") ?? u.searchParams.get("url") ?? rawHref;
            url = decodeURIComponent(url);
        }
        catch { /* keep rawHref */ }
        const title = titleEl.text().trim();
        const snippet = snippetEl.text().trim();
        if (title && url && url.startsWith("http")) {
            results.push({ title, url, snippet });
        }
    });
    return results;
}
async function fetchPage(url) {
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": "rock-mcp/0.5 (documentation indexer)",
                Accept: "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
            signal: AbortSignal.timeout(15_000),
            redirect: "follow",
        });
        if (!res.ok)
            return null;
        const contentType = res.headers.get("content-type") ?? "";
        // Only index HTML — plain text files get misparsed by the HTML pipeline
        if (!contentType.includes("text/html"))
            return null;
        const html = await res.text();
        return { html, finalUrl: res.url };
    }
    catch {
        return null;
    }
}
// Non-HTML file extensions to skip
const SKIP_EXTENSIONS = /\.(txt|pdf|json|xml|csv|zip|gz|tar|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|mp3|webm)(\?.*)?$/i;
export function normalizeUrl(url) {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    // Remove trailing slash except for bare root "/"
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
        u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
}
function extractLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const base = new URL(baseUrl);
    const links = [];
    $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href)
            return;
        try {
            const resolved = new URL(href, baseUrl);
            if (resolved.origin !== base.origin)
                return;
            if (SKIP_EXTENSIONS.test(resolved.pathname))
                return;
            links.push(normalizeUrl(resolved.toString()));
        }
        catch {
            // ignore invalid URLs
        }
    });
    return [...new Set(links)];
}
function htmlToMarkdown(html, url) {
    const $ = cheerio.load(html);
    const rawTitle = $("title").text().trim() ||
        $("h1").first().text().trim() ||
        new URL(url).pathname;
    // Guard against malformed pages where title extraction picks up large content blocks
    const title = rawTitle.slice(0, 300);
    // Remove noisy elements
    $("script, style, nav, footer, aside, [aria-hidden=true], .sidebar, #sidebar").remove();
    // Focus on main content if available
    const mainEl = $("main, article, .content, .docs-content, #content, .markdown-body");
    const contentHtml = mainEl.length ? mainEl.html() ?? "" : $("body").html() ?? "";
    let markdown = turndown.turndown(contentHtml);
    // Truncate if too long
    if (markdown.length > MAX_CONTENT_LENGTH) {
        markdown = markdown.slice(0, MAX_CONTENT_LENGTH) + "\n\n...[truncated]";
    }
    return { title, markdown };
}
function extractTopics(markdown) {
    // Extract heading text as topics, stripping markdown links
    const headings = [...markdown.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => {
        // Strip markdown links [text](url) → text, then strip remaining markdown syntax
        const text = m[1]
            .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
            .replace(/[`*_[\]]/g, "") // strip remaining markdown chars
            .trim()
            .toLowerCase();
        return text;
    }).filter((t) => t.length > 0 && t.length < 120);
    return [...new Set(headings)].slice(0, 30);
}
function buildSummary(markdown) {
    // First ~500 chars of non-heading content
    const lines = markdown
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"))
        .join(" ");
    return lines.slice(0, 500).trim();
}
function contentHash(content) {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
async function crawlSingle(url, sourceId, depth, parentUrl) {
    const fetched = await fetchPage(url);
    if (!fetched)
        return { links: [], page: null, canonicalUrl: url };
    const { html, finalUrl } = fetched;
    // Use the post-redirect URL as canonical to avoid duplicate storage
    const canonicalUrl = normalizeUrl(finalUrl);
    const existing = db
        .prepare("SELECT * FROM pages WHERE url = ?")
        .get(canonicalUrl);
    const { title, markdown } = htmlToMarkdown(html, finalUrl);
    const hash = contentHash(markdown);
    // Skip unchanged pages
    if (existing && existing.content_hash === hash) {
        return { links: extractLinks(html, finalUrl), page: existing, canonicalUrl };
    }
    const topics = extractTopics(markdown);
    const summary = buildSummary(markdown);
    const now = Date.now();
    // Wrap all writes in a transaction so page + topic_index are always consistent.
    // A crash mid-write previously left a page with no topics (expand_topic blind spot).
    const page = db.transaction(() => {
        if (existing) {
            db.prepare(`
        UPDATE pages SET title=?, content=?, summary=?, topics=?, crawled_at=?, content_hash=?, depth=?
        WHERE url=?
      `).run(title, markdown, summary, JSON.stringify(topics), now, hash, depth, canonicalUrl);
        }
        else {
            db.prepare(`
        INSERT OR REPLACE INTO pages (source_id, url, title, content, summary, topics, crawled_at, content_hash, parent_url, depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sourceId, canonicalUrl, title, markdown, summary, JSON.stringify(topics), now, hash, parentUrl, depth);
        }
        const saved = db.prepare("SELECT * FROM pages WHERE url = ?").get(canonicalUrl);
        db.prepare("DELETE FROM topic_index WHERE page_id = ?").run(saved.id);
        const insertTopic = db.prepare("INSERT INTO topic_index (page_id, topic) VALUES (?, ?)");
        for (const topic of topics) {
            insertTopic.run(saved.id, topic);
        }
        return saved;
    })();
    return { links: extractLinks(html, finalUrl), page, canonicalUrl };
}
export async function crawlSource(source, opts = {}) {
    const { maxDepth = 2, maxPages = 50, onProgress } = opts;
    db.prepare("UPDATE sources SET status=? WHERE id=?").run("crawling", source.id);
    const visited = new Set();
    const queue = [
        { url: source.url, depth: 0, parent: null },
    ];
    let pageCount = 0;
    let sourceTitleSet = !!source.title; // only set once from the root page
    while (queue.length > 0 && pageCount < maxPages) {
        // Clamp batch size to remaining page budget so we never overshoot maxPages.
        // Without this, a batch of CRAWL_CONCURRENCY=5 would be taken even when only
        // 1 page remains in budget, causing up to CONCURRENCY-1 extra pages to be indexed.
        const remaining = maxPages - pageCount;
        const batchSize = Math.min(CRAWL_CONCURRENCY, remaining);
        const batch = queue.splice(0, batchSize);
        await Promise.all(batch.map(async ({ url, depth, parent }) => {
            if (visited.has(url))
                return;
            visited.add(url);
            onProgress?.(url, depth);
            const { links, page, canonicalUrl } = await crawlSingle(url, source.id, depth, parent);
            // Mark canonical (post-redirect) URL visited to prevent duplicate crawls
            if (canonicalUrl !== url)
                visited.add(canonicalUrl);
            pageCount++;
            // Populate sources.title from the root page (depth 0) if not already set.
            // Previously this was always null, making list_sources useless for LLMs.
            if (!sourceTitleSet && depth === 0 && page?.title) {
                sourceTitleSet = true;
                db.prepare("UPDATE sources SET title=? WHERE id=?").run(page.title, source.id);
            }
            if (depth < maxDepth) {
                for (const link of links) {
                    if (!visited.has(link)) {
                        queue.push({ url: link, depth: depth + 1, parent: canonicalUrl });
                    }
                }
            }
        }));
        if (queue.length > 0) {
            await new Promise((r) => setTimeout(r, CRAWL_DELAY_MS));
        }
    }
    const now = Date.now();
    db.prepare("UPDATE sources SET status=?, last_crawled_at=? WHERE id=?").run("ready", now, source.id);
    return pageCount;
}
export function searchDocs(query, limit = 10) {
    if (!query.trim())
        return [];
    const terms = query
        .trim()
        .replace(/["*^()]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 1);
    if (terms.length === 0)
        return [];
    // Try AND first (precise), fall back to OR (broad), fall back to LIKE
    for (const joiner of [" AND ", " OR "]) {
        try {
            const ftsQuery = terms.map((t) => `"${t}"`).join(joiner);
            const pages = db
                .prepare(`SELECT p.id, p.source_id, p.url, p.title, p.summary, p.topics, p.crawled_at, p.content_hash, p.depth
           FROM pages p
           INNER JOIN pages_fts ON pages_fts.rowid = p.id
           WHERE pages_fts MATCH ?
           ORDER BY pages_fts.rank
           LIMIT ?`)
                .all(ftsQuery, limit);
            if (pages.length > 0) {
                // Re-attach empty content — callers use content only for excerpts which come from the DB separately
                return pages.map((p) => ({ ...p, content: "", parent_url: null }));
            }
        }
        catch {
            // FTS syntax error, try next strategy
        }
    }
    // Last resort: title LIKE
    const safe = `%${query.toLowerCase()}%`;
    const rows = db
        .prepare("SELECT id, source_id, url, title, summary, topics, crawled_at, content_hash, depth FROM pages WHERE LOWER(title) LIKE ? LIMIT ?")
        .all(safe, limit);
    return rows.map((p) => ({ ...p, content: "", parent_url: null }));
}
//# sourceMappingURL=crawler.js.map