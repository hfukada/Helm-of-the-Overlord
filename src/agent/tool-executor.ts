import path from "node:path";
import { logger } from "../shared/logger";

/**
 * Executes a single tool call in-process for OllamaAgent.
 *
 * @param toolName   Name of the tool (matches ToolDefinition.name)
 * @param args       Parsed arguments from the model's tool_call
 * @param workDir    Absolute path to the repo working directory
 * @returns          Tool output as a plain string (never throws)
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  workDir: string,
): Promise<string> {
  switch (toolName) {
    case "Read":
      return execRead(args, workDir);
    case "Glob":
      return execGlob(args, workDir);
    case "Grep":
      return execGrep(args, workDir);
    case "Write":
      return execWrite(args, workDir);
    case "Edit":
      return execEdit(args, workDir);
    case "Bash":
      return execBash(args, workDir);
    case "SearchKnowledge":
      logger.warn("executeTool: SearchKnowledge is not supported by OllamaAgent in-process executor", { toolName });
      return "Tool 'SearchKnowledge' is not supported by OllamaAgent. Use a ClaudeCodeCliAgent for knowledge base access.";
    default:
      return `Tool '${toolName}' is not supported by OllamaAgent`;
  }
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/** Returns the resolved absolute path, or null if it escapes workDir. */
function containedPath(workDir: string, filePath: string): string | null {
  const base = workDir.endsWith(path.sep) ? workDir : workDir + path.sep;
  const resolved = path.resolve(workDir, filePath);
  if (resolved !== workDir && !resolved.startsWith(base)) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function execRead(args: Record<string, unknown>, workDir: string): Promise<string> {
  const filePath = String(args.file_path ?? "");
  const resolved = containedPath(workDir, filePath);
  if (!resolved) return "Error: path is outside the working directory";
  try {
    return await Bun.file(resolved).text();
  } catch (err) {
    return `Error reading file: ${String(err)}`;
  }
}

async function execGlob(args: Record<string, unknown>, workDir: string): Promise<string> {
  const pattern = String(args.pattern ?? "");
  const searchPath = args.path ? String(args.path) : workDir;
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  for await (const match of glob.scan({ cwd: searchPath })) {
    matches.push(match);
  }
  return matches.join("\n");
}

async function execGrep(args: Record<string, unknown>, workDir: string): Promise<string> {
  const pattern = String(args.pattern ?? "");
  const searchPath = args.path ? String(args.path) : workDir;
  const globFilter = args.glob ? String(args.glob) : undefined;

  const cmd = globFilter
    ? ["grep", "-rn", "--include", globFilter, pattern, searchPath]
    : ["grep", "-rn", pattern, searchPath];

  const proc = Bun.spawn(cmd, { cwd: workDir, stdout: "pipe", stderr: "pipe" });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode === 0) {
    // Matches found — truncate if large.
    return stdout.length > 4000 ? stdout.slice(0, 4000) + "\n...(truncated)" : stdout;
  }
  if (exitCode === 1) {
    // grep exits 1 when there are no matches — not an error.
    return "";
  }
  // exitCode >= 2: real error (bad pattern, unreadable path, etc.)
  logger.warn("grep exited with error", { exitCode, pattern });
  return "";
}

async function execWrite(args: Record<string, unknown>, workDir: string): Promise<string> {
  const filePath = String(args.file_path ?? "");
  const content = String(args.content ?? "");
  const resolved = containedPath(workDir, filePath);
  if (!resolved) return "Error: path is outside the working directory";
  try {
    await Bun.write(resolved, content);
    return `Written: ${resolved}`;
  } catch (err) {
    return `Error writing file: ${String(err)}`;
  }
}

async function execEdit(args: Record<string, unknown>, workDir: string): Promise<string> {
  const filePath = String(args.file_path ?? "");
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  const resolved = containedPath(workDir, filePath);
  if (!resolved) return "Error: path is outside the working directory";
  let content: string;
  try {
    content = await Bun.file(resolved).text();
  } catch (err) {
    return `Error reading file: ${String(err)}`;
  }
  if (!content.includes(oldString)) {
    return `Error: old_string not found in ${resolved}`;
  }
  const updated = content.replace(oldString, newString);
  try {
    await Bun.write(resolved, updated);
    return `Edited: ${resolved}`;
  } catch (err) {
    return `Error writing file: ${String(err)}`;
  }
}

async function execBash(args: Record<string, unknown>, workDir: string): Promise<string> {
  const command = String(args.command ?? "");
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const combined = stdout + stderr;
  if (exitCode !== 0) {
    logger.warn("bash command exited non-zero", { exitCode, command });
  }
  return combined.length > 4000 ? combined.slice(0, 4000) + "\n...(truncated)" : combined;
}
