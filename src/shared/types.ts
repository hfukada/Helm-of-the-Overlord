export type TaskStatus =
  | "pending"
  | "indexing"
  | "scoping"
  | "planning"
  | "scrutinizing"
  | "replanning"
  | "finalizing_plan"
  | "implementing"
  | "linting"
  | "fix_linting"
  | "ci_running"
  | "ci_fixing"
  | "review"
  | "waiting_for_input"
  | "spawning_children"
  | "waiting_for_children"
  | "accepted"
  | "committed"
  | "error"
  | "failed"
  | "cancelled"
  | "resuming";

export type ChildTaskStatus =
  | "pending"
  | "resuming"
  | "implementing"
  | "linting"
  | "fix_linting"
  | "ci_running"
  | "ci_fixing"
  | "review"
  | "committed"
  | "error"
  | "cancelled";

export type TaskSource = "cli" | "web" | "messaging";

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
  child_task_id?: string;
}

export interface ChildTask {
  id: string;
  parent_task_id: string;
  repo_id: number;
  status: ChildTaskStatus;
  blueprint_state: BlueprintState | null;
  branch_name: string | null;
  plan_excerpt: string;
  pr_number: number | null;
  pr_url: string | null;
  ci_output: string | null;
  ci_passed: boolean | null;
  lint_output: string | null;
  lint_passed: boolean | null;
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
  docker_image: string | null;
  ci_on_host: boolean;
  metadata: Record<string, unknown> | null;
  index_commit_hash?: string | null;
  extra_context: string | null;
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

export type BlueprintNodeType = "index" | "pre_plan" | "plan" | "scrutinize" | "plan_again" | "scrutinize_final" | "finalize_plan" | "implement" | "lint" | "push" | "ci" | "fix_lint" | "fix_ci" | "review" | "revise" | "commit" | "understand_review" | "review_small_feedback" | "review_large_feedback";

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


export interface TaskListItem {
  id: string;
  title: string;
  status: TaskStatus;
  repo_id: number | null;
  branch_name: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  total_tokens: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface TaskRepo {
  task_id: string;
  repo_id: number;
  role: "target" | "context";
}

export interface TaskPR {
  id: number;
  task_id: string;
  repo_id: number;
  pr_number: number;
  pr_url: string;
  last_review_id: number;
  last_comment_id: number;
  status: "open" | "merged" | "closed";
}

export interface ContainerSecret {
  id: number;
  repo_id: number;
  secret_type: "env_var" | "auth_file" | "ssh_key";
  key: string;
  value_source: "host_env" | "host_file";
  host_path: string | null;
  container_path: string | null;
  description: string | null;
  known_hosts_path: string | null;
  discovered_by: "manual" | "auto";
  verified: boolean;
  created_at: string;
}

export type ProjectStatus = "active" | "planning" | "in_progress" | "revising" | "completed" | "failed" | "cancelled";

export interface ProjectMilestone {
  index: number;
  title: string;
  description: string;
  files_estimate: number;
  task_id: string | null;
  completed: boolean;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  status: ProjectStatus;
  architecture_notes: string | null;
  carry_over_notes: string | null;
  milestones: ProjectMilestone[];
  current_milestone: number;
  repo_id: number | null;
  repo_names: string[];
  source_sender_id: string | null;
  source_provider: string | null;
  created_at: string;
  updated_at: string;
}
