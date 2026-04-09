/** Common sandbox options passed to agentic nodes when running in a container. */
export interface SandboxOptions {
  containerName: string;
  containerWorkDir: string;
  /** Base workspace path (task dir) inside the sandbox -- for deriving per-repo paths */
  workspaceBase: string;
}
