import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";
import type { ContainerSecret } from "../shared/types";

/**
 * Patterns that indicate a missing secret in container output.
 * Each pattern maps stderr/stdout content to a candidate secret.
 */
interface SecretPattern {
  /** Regex to match against combined output */
  pattern: RegExp;
  /** Extract the secret definition from the match */
  extract: (match: RegExpMatchArray) => {
    secret_type: "env_var" | "auth_file" | "ssh_key";
    key: string;
    value_source: "host_env" | "host_file";
    host_path?: string;
    container_path?: string;
    description: string;
  };
}

const PATTERNS: SecretPattern[] = [
  // Generic "env var not set" patterns
  {
    pattern: /(?:environment variable|env var|envvar)\s+['"`]?(\w+)['"`]?\s+(?:is not set|not found|not defined|undefined|missing)/i,
    extract: (m) => ({
      secret_type: "env_var",
      key: m[1],
      value_source: "host_env",
      description: `Auto-detected: ${m[0].trim()}`,
    }),
  },
  {
    pattern: /(?:missing|required|undefined)\s+(?:environment variable|env var|envvar)\s+['"`]?(\w+)['"`]?/i,
    extract: (m) => ({
      secret_type: "env_var",
      key: m[1],
      value_source: "host_env",
      description: `Auto-detected: ${m[0].trim()}`,
    }),
  },
  // process.env.X is undefined / not set
  {
    pattern: /process\.env\.(\w+)\s+is\s+(?:undefined|not defined)/i,
    extract: (m) => ({
      secret_type: "env_var",
      key: m[1],
      value_source: "host_env",
      description: `Auto-detected: ${m[0].trim()}`,
    }),
  },
  // KeyError: 'X' (Python missing env)
  {
    pattern: /KeyError:\s*['"](\w+)['"]/,
    extract: (m) => ({
      secret_type: "env_var",
      key: m[1],
      value_source: "host_env",
      description: `Auto-detected: Python KeyError for '${m[1]}' (likely missing env var)`,
    }),
  },
  // Common API key env vars that appear in error messages
  {
    pattern: /\b((?:ANTHROPIC|OPENAI|GITHUB|GITLAB|AWS|GCP|AZURE|DOCKER|NPM|PYPI|HUGGING_FACE|HF)[-_]?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS|AUTH))\b.*(?:not set|missing|required|undefined|invalid|empty)/i,
    extract: (m) => ({
      secret_type: "env_var",
      key: m[1],
      value_source: "host_env",
      description: `Auto-detected: API key/token appears missing`,
    }),
  },
  // File not found for common auth paths
  {
    pattern: /(?:no such file|not found|ENOENT|FileNotFoundError).*?(\/(?:root|home\/\w+)\/\.(?:claude|aws|ssh|docker|npmrc|pypirc|gitconfig|kube|gcloud)[/\w.]*)/i,
    extract: (m) => ({
      secret_type: "auth_file",
      key: m[1].split("/").pop() ?? m[1],
      value_source: "host_file",
      host_path: m[1].replace(/^\/root\//, `${process.env.HOME ?? "/root"}/`),
      container_path: m[1],
      description: `Auto-detected: auth file not found in container`,
    }),
  },
  // Permission denied on credential files
  {
    pattern: /(?:permission denied|EACCES).*?(\/(?:root|home\/\w+)\/\.(?:claude|aws|ssh|docker|npmrc|pypirc|kube|gcloud)[/\w.]*)/i,
    extract: (m) => ({
      secret_type: "auth_file",
      key: m[1].split("/").pop() ?? m[1],
      value_source: "host_file",
      host_path: m[1].replace(/^\/root\//, `${process.env.HOME ?? "/root"}/`),
      container_path: m[1],
      description: `Auto-detected: permission denied on credential file`,
    }),
  },
  // npm ERR! 401 / 403 -- registry auth
  {
    pattern: /npm ERR!\s+(?:401|403)/,
    extract: () => ({
      secret_type: "auth_file",
      key: ".npmrc",
      value_source: "host_file",
      host_path: `${process.env.HOME ?? "/root"}/.npmrc`,
      container_path: "/root/.npmrc",
      description: "Auto-detected: npm registry auth failure (401/403)",
    }),
  },
  // pip/poetry auth failures
  {
    pattern: /(?:pip|poetry).*(?:401|403|authentication|credentials)/i,
    extract: () => ({
      secret_type: "auth_file",
      key: ".pypirc",
      value_source: "host_file",
      host_path: `${process.env.HOME ?? "/root"}/.pypirc`,
      container_path: "/root/.pypirc",
      description: "Auto-detected: Python package registry auth failure",
    }),
  },
  // SSH: public key auth failure
  {
    pattern: /Permission denied \(publickey\)/i,
    extract: () => ({
      secret_type: "ssh_key",
      key: "SSH_KEY",
      value_source: "host_file",
      description:
        "Auto-detected: SSH public key auth failed. Register an SSH key with: hoto repos secrets add --ssh-key <path>, or use $ENV_VAR syntax in the repo URL.",
    }),
  },
  // SSH: host key verification failure
  {
    pattern: /Host key verification failed/i,
    extract: () => ({
      secret_type: "ssh_key",
      key: "SSH_KNOWN_HOSTS",
      value_source: "host_file",
      description:
        "Auto-detected: SSH host key verification failed. Register a known_hosts file when adding an SSH key secret, or use $ENV_VAR syntax in the repo URL.",
    }),
  },
  // HTTPS: invalid credentials
  {
    pattern: /remote: Invalid username or password/i,
    extract: () => ({
      secret_type: "env_var",
      key: "GIT_TOKEN",
      value_source: "host_env",
      description:
        "Auto-detected: Git HTTPS auth failed (invalid credentials). Set a token env var and use $ENV_VAR syntax in the repo URL (e.g. https://$GIT_TOKEN@host/repo).",
    }),
  },
  // HTTPS: 403 Forbidden from git
  {
    pattern: /fatal:.*403|The requested URL returned error: 403/i,
    extract: () => ({
      secret_type: "env_var",
      key: "GIT_TOKEN",
      value_source: "host_env",
      description:
        "Auto-detected: Git HTTPS auth failed (403 Forbidden). Set a token env var and use $ENV_VAR syntax in the repo URL (e.g. https://$GIT_TOKEN@host/repo).",
    }),
  },
];

/**
 * Scan CI/lint/build output for signs of missing secrets.
 * Records any discoveries in the container_secrets table.
 * Returns the list of newly discovered secrets.
 */
export function discoverSecrets(
  repoId: number,
  output: string
): ContainerSecret[] {
  const db = getDb();
  const discovered: ContainerSecret[] = [];

  for (const { pattern, extract } of PATTERNS) {
    const match = output.match(pattern);
    if (!match) continue;

    const candidate = extract(match);

    // Check if already exists
    const existing = db.query(
      "SELECT id FROM container_secrets WHERE repo_id = ? AND secret_type = ? AND key = ?"
    ).get(repoId, candidate.secret_type, candidate.key);

    if (existing) continue;

    try {
      const result = db.run(
        `INSERT INTO container_secrets (repo_id, secret_type, key, value_source, host_path, container_path, description, discovered_by, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', 0)`,
        [
          repoId,
          candidate.secret_type,
          candidate.key,
          candidate.value_source,
          candidate.host_path ?? null,
          candidate.container_path ?? null,
          candidate.description,
        ]
      );

      const secret: ContainerSecret = {
        id: Number(result.lastInsertRowid),
        repo_id: repoId,
        secret_type: candidate.secret_type,
        key: candidate.key,
        value_source: candidate.value_source,
        host_path: candidate.host_path ?? null,
        container_path: candidate.container_path ?? null,
        description: candidate.description,
        discovered_by: "auto",
        verified: false,
        created_at: new Date().toISOString(),
      };

      discovered.push(secret);

      logger.info("Auto-discovered container secret", {
        repoId,
        type: candidate.secret_type,
        key: candidate.key,
        description: candidate.description,
      });
    } catch (err) {
      // UNIQUE constraint violation -- already exists
      if (!String(err).includes("UNIQUE")) {
        logger.warn("Failed to record discovered secret", { error: String(err) });
      }
    }
  }

  return discovered;
}
