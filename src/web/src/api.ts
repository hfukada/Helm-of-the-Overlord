const BASE = window.location.origin;

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// Tasks
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  repo_id: number | null;
  branch_name: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface DiffSummaryItem {
  file: string;
  insertions: number;
  deletions: number;
}

export interface AgentRun {
  id: string;
  node_name: string;
  agent_type: string;
  status: string;
  token_input: number;
  token_output: number;
  cost_usd: number;
  model: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface BlueprintHistoryEntry {
  node: string;
  entered_at: string;
  exited_at: string | null;
  result: string | null;
}

export interface BlueprintState {
  current_node: string;
  history: BlueprintHistoryEntry[];
  ci_rounds: number;
  lint_rounds: number;
}

export interface TaskDetail extends TaskSummary {
  description: string;
  blueprint_state: BlueprintState | null;
  diff: string | null;
  diff_summary: DiffSummaryItem[] | null;
  agent_runs: AgentRun[];
  lint_output: string | null;
  lint_passed: number | null;
  ci_output: string | null;
  ci_passed: number | null;
}

export interface StreamEvent {
  id: number;
  agent_run_id: string;
  event_type: string;
  content: string;
  timestamp: string;
}

export interface DiffComment {
  id: number;
  task_id: string;
  file_path: string;
  line_number: number | null;
  side: string;
  body: string;
  resolved: number;
}

export interface Repo {
  id: number;
  name: string;
  path: string;
  description: string | null;
  language: string | null;
  framework: string | null;
}

export interface TokenUsageRow {
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface TokenUsageResponse {
  daily: TokenUsageRow[];
  totals: {
    total_input: number;
    total_output: number;
    total_cost: number;
  };
}

export function fetchTasks(): Promise<TaskSummary[]> {
  return request("/tasks");
}

export function fetchTask(id: string): Promise<TaskDetail> {
  return request(`/tasks/${id}`);
}

export function submitTask(
  description: string,
  repoName?: string,
  source: string = "web"
): Promise<{ id: string; title: string; status: string }> {
  return request("/tasks", {
    method: "POST",
    body: JSON.stringify({ description, repo_name: repoName, source }),
  });
}

export function cancelTask(
  id: string
): Promise<{ id: string; status: string }> {
  return request(`/tasks/${id}/cancel`, { method: "POST" });
}

export function deleteTask(id: string): Promise<{ id: string; deleted: boolean }> {
  return request(`/tasks/${id}`, { method: "DELETE" });
}

export function fetchAgentStream(
  taskId: string,
  runId: string,
  after: number = 0
): Promise<StreamEvent[]> {
  return request(`/tasks/${taskId}/agents/${runId}/stream?after=${after}`);
}

export interface LintOutputResponse {
  lint_output: string | null;
  lint_passed: number | null;
  status: string;
}

export function fetchLintOutput(taskId: string): Promise<LintOutputResponse> {
  return request(`/tasks/${taskId}/lint-output`);
}

export interface CiOutputResponse {
  ci_output: string | null;
  ci_passed: number | null;
  status: string;
}

export function fetchCiOutput(taskId: string): Promise<CiOutputResponse> {
  return request(`/tasks/${taskId}/ci-output`);
}

// Comments
export function fetchComments(taskId: string): Promise<DiffComment[]> {
  return request(`/tasks/${taskId}/comments`);
}

export function postComment(
  taskId: string,
  filePath: string,
  lineNumber: number | null,
  side: string,
  body: string
): Promise<DiffComment> {
  return request(`/tasks/${taskId}/comments`, {
    method: "POST",
    body: JSON.stringify({
      file_path: filePath,
      line_number: lineNumber,
      side,
      body,
    }),
  });
}

export function updateComment(
  commentId: number,
  updates: { body?: string; resolved?: boolean }
): Promise<DiffComment> {
  return request(`/comments/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function deleteComment(commentId: number): Promise<{ deleted: boolean }> {
  return request(`/comments/${commentId}`, { method: "DELETE" });
}

// Commits
export function acceptTask(
  id: string
): Promise<{ id: string; status: string }> {
  return request(`/tasks/${id}/accept`, { method: "POST" });
}

export function commitTask(
  id: string,
  message: string,
  branchName?: string
): Promise<{ id: string; status: string; branch: string }> {
  return request(`/tasks/${id}/commit`, {
    method: "POST",
    body: JSON.stringify({ message, branch_name: branchName }),
  });
}

export function rejectTask(
  id: string,
  comment: string
): Promise<{ id: string; status: string }> {
  return request(`/tasks/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ comment }),
  });
}

// Repos
export function fetchRepos(): Promise<Repo[]> {
  return request("/repos");
}

// Tokens
export function fetchTokens(): Promise<TokenUsageResponse> {
  return request("/tokens");
}
