// MCP server for hoto -- spawned by claude CLI via stdio transport.
// Receives JSON-RPC on stdin, responds on stdout.
// Env vars: HOTO_WORK_DIR, HOTO_REPO_NAME, HOTO_DAEMON_URL

const WORK_DIR = process.env.HOTO_WORK_DIR ?? "";
const REPO_NAME = process.env.HOTO_REPO_NAME ?? "";
const DAEMON_URL = process.env.HOTO_DAEMON_URL || "http://127.0.0.1:7777";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: "search_knowledge",
    description: "Search the indexed knowledge base for relevant code and documentation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 8)" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_files",
    description: "List files tracked by git in the repository, optionally filtered by glob pattern.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to filter files (e.g. 'src/**/*.ts')" },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a file from the working directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to file" },
        offset: { type: "number", description: "Line offset (0-based)" },
        limit: { type: "number", description: "Max lines to read" },
      },
      required: ["path"],
    },
  },
];

function respond(id: number | string | null, result: unknown): void {
  const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  const json = JSON.stringify(msg);
  process.stdout.write(`${json}\n`);
}

function respondError(id: number | string | null, code: number, message: string): void {
  const msg: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
  const json = JSON.stringify(msg);
  process.stdout.write(`${json}\n`);
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "search_knowledge": {
      const query = args.query as string;
      const limit = (args.limit as number) || 8;
      const res = await fetch(`${DAEMON_URL}/knowledge/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, repo_name: REPO_NAME, limit }),
      });
      const data = await res.json() as { results: Array<{ source_file: string; chunk_type: string; content: string }> };
      const text = data.results
        .map((r: { source_file: string; chunk_type: string; content: string }) => `## ${r.source_file} (${r.chunk_type})\n${r.content}`)
        .join("\n\n");
      return { content: [{ type: "text", text: text || "No results found." }] };
    }

    case "list_files": {
      const pattern = args.pattern as string | undefined;
      const res = await fetch(`${DAEMON_URL}/knowledge/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_name: REPO_NAME, pattern }),
      });
      const data = await res.json() as { files: string[] };
      return { content: [{ type: "text", text: data.files.join("\n") || "No files found." }] };
    }

    case "read_file": {
      const filePath = args.path as string;
      const offset = (args.offset as number) || 0;
      const limit = (args.limit as number) || 0;

      const { join } = await import("node:path");
      const fullPath = join(WORK_DIR, filePath);

      try {
        const file = Bun.file(fullPath);
        const text = await file.text();
        const lines = text.split("\n");

        let selected: string[];
        if (offset > 0 || limit > 0) {
          const start = offset;
          const end = limit > 0 ? start + limit : lines.length;
          selected = lines.slice(start, end);
        } else {
          selected = lines;
        }

        // Add line numbers
        const numbered = selected.map((line, i) => `${offset + i + 1}\t${line}`);
        return { content: [{ type: "text", text: numbered.join("\n") }] };
      } catch {
        return { content: [{ type: "text", text: `Error: file not found: ${filePath}` }], isError: true };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
  const { method, id, params } = msg;

  switch (method) {
    case "initialize":
      respond(id ?? null, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "hoto", version: "1.0.0" },
      });
      break;

    case "notifications/initialized":
      // No response needed for notifications
      break;

    case "tools/list":
      respond(id ?? null, { tools: TOOLS });
      break;

    case "tools/call": {
      const toolName = (params?.name as string) || "";
      const toolArgs = (params?.arguments as Record<string, unknown>) || {};
      try {
        const result = await handleToolCall(toolName, toolArgs);
        respond(id ?? null, result);
      } catch (err) {
        respondError(id ?? null, -32603, err instanceof Error ? err.message : String(err));
      }
      break;
    }

    default:
      respondError(id ?? null, -32601, `Method not found: ${method}`);
  }
}

// Read JSON-RPC messages from stdin (newline-delimited)
async function main(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcRequest;
        await handleMessage(msg);
      } catch (err) {
        respondError(null, -32700, `Parse error: ${err}`);
      }
    }
  }
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
