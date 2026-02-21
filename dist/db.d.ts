import { type Database as DB } from "better-sqlite3";
export declare const db: DB;
export declare const STALE_THRESHOLD_MS: number;
export type Source = {
    id: number;
    url: string;
    title: string | null;
    description: string | null;
    added_at: number;
    last_crawled_at: number | null;
    crawl_depth: number;
    max_pages: number;
    status: "pending" | "crawling" | "ready" | "error";
};
export type Page = {
    id: number;
    source_id: number;
    url: string;
    title: string | null;
    content: string;
    summary: string | null;
    topics: string | null;
    crawled_at: number;
    content_hash: string;
    parent_url: string | null;
    depth: number;
};
//# sourceMappingURL=db.d.ts.map