/**
 * Minimal MCP HTTP client for OllamaAgent tool dispatch.
 * Translates a tool name + args into a JSON-RPC tools/call POST
 * and returns the result text. Never throws — returns an error string on failure.
 */

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  opts: { mcpUrl: string; repoName: string },
): Promise<string> {
  const url = `${opts.mcpUrl}/message?repo=${encodeURIComponent(opts.repoName)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
  } catch (err) {
    return `MCP fetch error: ${String(err)}`;
  }

  if (!res.ok) {
    return `MCP HTTP error: ${res.status}`;
  }

  let body: { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
  try {
    body = await res.json();
  } catch (err) {
    return `MCP JSON parse error: ${String(err)}`;
  }

  if (body.error) {
    return `MCP error: ${body.error.message ?? JSON.stringify(body.error)}`;
  }

  return body.result?.content?.[0]?.text ?? "";
}
