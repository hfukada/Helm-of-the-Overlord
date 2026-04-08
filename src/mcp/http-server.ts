/**
 * MCP HTTP server -- exposes the same tools as the stdio server
 * over HTTP using SSE (Server-Sent Events) transport.
 *
 * This allows sandboxed Claude containers to access the knowledge base
 * by connecting to http://host.docker.internal:<port>/sse.
 *
 * Started by the daemon when HOTO_SANDBOX_CLAUDE is enabled.
 */

import { Hono } from "hono";
import { logger } from "../shared/logger";
import { config } from "../shared/config";

const TOOLS = [
  {
    name: "search_knowledge",
    description: "Search the indexed knowledge base for relevant code and documentation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 8)" },
      },
      required: ["query"],
    },
  },
];

const DAEMON_URL = `http://127.0.0.1:${config.daemonPort}`;

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  repoName: string,
): Promise<unknown> {
  switch (name) {
    case "search_knowledge": {
      const query = args.query as string;
      const limit = (args.limit as number) || 8;
      const res = await fetch(`${DAEMON_URL}/knowledge/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, repo_name: repoName, limit }),
      });
      const data = await res.json() as {
        results: Array<{ source_file: string; chunk_type: string; content: string }>
      };
      const text = data.results
        .map((r) => `## ${r.source_file} (${r.chunk_type})\n${r.content}`)
        .join("\n\n");
      return { content: [{ type: "text", text: text || "No results found." }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Create and start the MCP HTTP server.
 * Returns a cleanup function to stop it.
 */
export function startMcpHttpServer(): { port: number; stop: () => void } {
  const app = new Hono();

  // SSE endpoint -- implements MCP over HTTP/SSE transport
  // The client connects via SSE and sends JSON-RPC messages via POST.
  // We use a simpler REST approach here since claude CLI's SSE client
  // expects specific endpoints.

  // Session state per connection
  const sessions = new Map<string, { repoName: string }>();

  // POST /message -- JSON-RPC handler
  app.post("/message", async (c) => {
    const body = await c.req.json() as {
      jsonrpc: string;
      id?: number | string;
      method: string;
      params?: Record<string, unknown>;
    };

    const sessionId = c.req.query("sessionId") ?? "default";
    const session = sessions.get(sessionId);
    const repoName = session?.repoName ?? c.req.query("repo") ?? "";

    switch (body.method) {
      case "initialize":
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "hoto", version: "1.0.0" },
          },
        });

      case "notifications/initialized":
        return c.json({ jsonrpc: "2.0", id: body.id, result: {} });

      case "tools/list":
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: TOOLS },
        });

      case "tools/call": {
        const toolName = (body.params?.name as string) ?? "";
        const toolArgs = (body.params?.arguments as Record<string, unknown>) ?? {};
        try {
          const result = await handleToolCall(toolName, toolArgs, repoName);
          return c.json({ jsonrpc: "2.0", id: body.id, result });
        } catch (err) {
          return c.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32603, message: String(err) },
          });
        }
      }

      default:
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: `Method not found: ${body.method}` },
        });
    }
  });

  // SSE endpoint -- claude CLI connects here for the SSE transport
  app.get("/sse", (c) => {
    const repo = c.req.query("repo") ?? "";
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { repoName: repo });

    // Return SSE stream with the endpoint URL
    const messageUrl = `http://host.docker.internal:${config.mcpHttpPort}/message?sessionId=${sessionId}&repo=${repo}`;

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    const stream = new ReadableStream({
      start(controller) {
        // Send the endpoint event that tells the client where to POST messages
        controller.enqueue(
          new TextEncoder().encode(`event: endpoint\ndata: ${messageUrl}\n\n`)
        );

        // Keep connection alive with periodic pings
        const pingInterval = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": ping\n\n"));
          } catch {
            clearInterval(pingInterval);
          }
        }, 30000);

        // Clean up on close
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(pingInterval);
          sessions.delete(sessionId);
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  // Health check
  app.get("/health", (c) => c.json({ status: "ok", transport: "mcp-http" }));

  const server = Bun.serve({
    port: config.mcpHttpPort,
    hostname: "0.0.0.0", // Listen on all interfaces so containers can reach it
    fetch: app.fetch,
  });

  logger.info("MCP HTTP server started", { port: config.mcpHttpPort });

  return {
    port: config.mcpHttpPort,
    stop: () => {
      server.stop();
      sessions.clear();
      logger.info("MCP HTTP server stopped");
    },
  };
}
