import { type Page, type Source } from "./db.js";
export type WebSearchResult = {
    title: string;
    url: string;
    snippet: string;
};
export declare function searchWeb(query: string, limit?: number): Promise<WebSearchResult[]>;
export type CrawlOptions = {
    maxDepth?: number;
    maxPages?: number;
    includeExternal?: boolean;
    onProgress?: (url: string, depth: number) => void;
};
export declare function normalizeUrl(url: string): string;
export declare function crawlSource(source: Source, opts?: CrawlOptions): Promise<number>;
export declare function searchDocs(query: string, limit?: number): Page[];
//# sourceMappingURL=crawler.d.ts.map