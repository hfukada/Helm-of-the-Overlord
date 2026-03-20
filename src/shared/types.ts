export type TaskStatus =
  | "pending"
  | "indexing"
  | "planning"
  | "implementing"
  | "linting"
  | "fix_linting"
  | "ci_running"
  | "ci_fixing"
  | "review"
  | "accepted"
  | "committed"
  | "failed"
  | "cancelled";

export type TaskSource = "cli" | "web";

export interface Task {
  id: string;
  title: string;
  description: string;
  repo_id: number | null;
  status: TaskStatus;
  blueprint_state: BlueprintState | null;
  branch_name: string | null;
  source: TaskSource;
  use_full_copy: boolean;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  name: string;
  path: string;
  description: string | null;
  build_cmd: string | null;
  test_cmd: string | null;
  run_cmd: string | null;
  lint_cmd: string | null;
  language: string | null;
  framework: string | null;
  docker_compose_path: string | null;
  metadata: Record<string, unknown> | null;
  index_commit_hash?: string | null;
}

export type AgentRunStatus = "running" | "completed" | "failed";

export interface AgentRun {
  id: string;
  task_id: string;
  node_name: string;
  agent_type: "agentic" | "deterministic";
  status: AgentRunStatus;
  prompt: string;
  output: string | null;
  token_input: number;
  token_output: number;
  cost_usd: number;
  model: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export type StreamEventType =
  | "thinking"
  | "text"
  | "tool_use"
  | "tool_result"
  | "error";

export interface AgentStreamEvent {
  id: number;
  agent_run_id: string;
  event_type: StreamEventType;
  content: string;
  timestamp: string;
}

export type BlueprintNodeType = "index" | "plan" | "implement" | "lint" | "push" | "ci" | "fix_lint" | "fix_ci" | "review" | "revise" | "commit";

export interface BlueprintNode {
  name: BlueprintNodeType;
  type: "agentic" | "deterministic" | "human";
  transitions: Record<string, BlueprintNodeType>;
}

export interface BlueprintState {
  current_node: BlueprintNodeType;
  history: Array<{
    node: BlueprintNodeType;
    entered_at: string;
    exited_at: string | null;
    result: string | null;
  }>;
  ci_rounds: number;
  lint_rounds: number;
}


export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface ContainerSecret {
  id: number;
  repo_id: number;
  secret_type: "env_var" | "auth_file";
  key: string;
  value_source: "host_env" | "host_file";
  host_path: string | null;
  container_path: string | null;
  description: string | null;
  discovered_by: "manual" | "auto";
  verified: boolean;
  created_at: string;
}
