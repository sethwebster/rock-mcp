# rock-mcp

Documentation crawler MCP server. Share a link → site gets crawled and indexed → any MCP-compatible AI can search, read, and expand on it.

No API keys. No cloud. Runs locally, stores everything in SQLite.

## How it works

1. Share a docs URL (`add_docs_url`)
2. rock-mcp crawls and indexes it in the background
3. Ask your AI about it — it searches, reads pages, and expands topics on demand

## Tools

| Tool | Description |
|---|---|
| `search_web` | Search the web via DuckDuckGo — find URLs when you don't have one yet |
| `add_docs_url` | Crawl and index a URL (async, call immediately then search) |
| `search_docs` | Full-text search across all indexed docs |
| `get_page` | Get a specific page, chunked. Jump to a section by name. |
| `expand_topic` | Find all pages covering a topic |
| `list_sources` | List indexed sources with crawl status and staleness |
| `recrawl_source` | Re-crawl a source to pick up updates |
| `get_crawl_status` | Check crawl progress for a URL |
| `delete_source` | Remove a source and all its pages |

## Installation

### Prerequisites

- Node.js 18+
- Git

```bash
git clone https://github.com/sethwebster/rock-mcp
cd rock-mcp
npm install && npm run build
```

Note the full path to `dist/server.js` — you'll need it below.

---

### Claude Code (CLI)

```bash
claude mcp add --scope user rock-mcp node /path/to/rock-mcp/dist/server.js
```

Restart Claude Code after running this. Verify with:

```bash
claude mcp list
```

---

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "rock-mcp": {
      "command": "node",
      "args": ["/path/to/rock-mcp/dist/server.js"]
    }
  }
}
```

Restart Claude Desktop.

---

### Cursor

Add to `.cursor/mcp.json` in your project root, or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "rock-mcp": {
      "command": "node",
      "args": ["/path/to/rock-mcp/dist/server.js"]
    }
  }
}
```

Restart Cursor.

---

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "rock-mcp": {
      "command": "node",
      "args": ["/path/to/rock-mcp/dist/server.js"]
    }
  }
}
```

Restart Windsurf.

---

### Codex (OpenAI CLI)

Add to `~/.codex/config.yaml` (or your project's `codex.yaml`):

```yaml
mcp_servers:
  - name: rock-mcp
    command: node
    args:
      - /path/to/rock-mcp/dist/server.js
```

---

### Cline (VS Code extension)

Open VS Code settings, search for **Cline MCP**, and add:

```json
{
  "rock-mcp": {
    "command": "node",
    "args": ["/path/to/rock-mcp/dist/server.js"]
  }
}
```

Or edit `settings.json` directly under the `cline.mcpServers` key.

---

### Continue.dev

Add to `~/.continue/config.json` under `mcpServers`:

```json
{
  "mcpServers": [
    {
      "name": "rock-mcp",
      "command": "node",
      "args": ["/path/to/rock-mcp/dist/server.js"]
    }
  ]
}
```

---

### Antigravity (Firebase Studio / Project IDX)

Add to `.idx/mcp.json` in your workspace root (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "rock-mcp": {
      "command": "node",
      "args": ["/path/to/rock-mcp/dist/server.js"]
    }
  }
}
```

For Gemini CLI within Firebase Studio, add to `.gemini/settings.json` instead:

```json
{
  "mcpServers": {
    "rock-mcp": {
      "command": "node",
      "args": ["/path/to/rock-mcp/dist/server.js"]
    }
  }
}
```

---

### Zed

Add to `~/.config/zed/settings.json` under `context_servers`:

```json
{
  "context_servers": {
    "rock-mcp": {
      "command": {
        "path": "node",
        "args": ["/path/to/rock-mcp/dist/server.js"]
      }
    }
  }
}
```

---

### Any MCP-compatible client

rock-mcp is a standard MCP stdio server. The binary is `node /path/to/rock-mcp/dist/server.js`. If your client supports MCP, point it there.

---

## Storage

All data lives in `~/.rock-mcp/docs.db` (SQLite, WAL mode). Delete it to reset everything.

## Crawl defaults

- Depth: 2 hops from the root URL
- Max pages: 50 per source
- Concurrency: 5 pages at a time, 200ms between batches
- Only indexes `text/html` — skips PDFs, plain text, JSON, etc.
- Redirect deduplication: follows redirects and stores under the canonical URL

## License

MIT
