import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { config } from "../shared/config";
import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";

const ADMIN_TOKEN_FILE = "/gitea-data/gitea/hoto-admin-token";

let _botToken: string | null = null;

function giteaUrl(path: string): string {
  return `${config.giteaUrl}${path}`;
}

/** Rewrite a Gitea-generated URL to use GITEA_URL as the base (Gitea may return an internal hostname). */
export function rewriteGiteaUrl(url: string): string {
  if (!config.giteaUrl) return url;
  try {
    const target = new URL(config.giteaUrl);
    const parsed = new URL(url);
    parsed.protocol = target.protocol;
    parsed.host = target.host;
    return parsed.toString();
  } catch {
    return url;
  }
}

function authHeaders(token?: string): Record<string, string> {
  const t = token ?? _botToken;
  if (!t) throw new Error("Gitea bot token not initialized");
  return {
    Authorization: `token ${t}`,
    "Content-Type": "application/json",
  };
}

async function giteaFetch(
  path: string,
  opts: RequestInit = {},
  token?: string
): Promise<Response> {
  const url = giteaUrl(path);
  const headers = { ...authHeaders(token), ...(opts.headers as Record<string, string> ?? {}) };
  return fetch(url, { ...opts, headers });
}

// -- Initialization ----------------------------------------------------------

export async function initGiteaClient(): Promise<void> {
  if (!config.giteaUrl) return;

  // Wait for Gitea to be ready
  await waitForGitea();

  const username = config.giteaBotUser;
  const password = config.giteaBotPassword;

  // 1. Try stored token
  const db = getDb();
  const stored = db.query("SELECT value FROM messaging_config WHERE key = 'gitea_bot_token'").get() as { value: string } | null;
  if (stored) {
    _botToken = stored.value;
    try {
      const res = await giteaFetch("/api/v1/user");
      if (res.ok) {
        logger.info("Gitea client initialized with stored token");
        await ensureOrg();
        return;
      }
    } catch {}
    _botToken = null;
  }

  // 2. Try logging in with configured credentials
  if (await loginAndCreateToken(username, password)) {
    logger.info("Gitea client initialized via login", { username });
    await ensureOrg();
    return;
  }

  // 3. Login failed -- create the user via admin token, then login
  logger.info("Gitea login failed, creating bot user via admin API", { username });
  await createBotUser(username, password);
  if (await loginAndCreateToken(username, password)) {
    logger.info("Gitea client initialized after user creation", { username });
    await ensureOrg();
    return;
  }

  // If we still can't auth, something is fundamentally wrong
  logger.error("Gitea authentication failed after user creation, exiting");
  process.exit(1);
}

async function waitForGitea(): Promise<void> {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(giteaUrl("/api/v1/version"), { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {}
    logger.info("Waiting for Gitea to be ready...", { attempt: i + 1 });
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Gitea did not become ready in time");
}

async function getAdminToken(): Promise<string> {
  // Try env var first
  if (config.giteaAdminToken) return config.giteaAdminToken;

  // Try reading from the auto-generated token file (written by gitea-init.sh)
  if (existsSync(ADMIN_TOKEN_FILE)) {
    const token = (await readFile(ADMIN_TOKEN_FILE, "utf-8")).trim();
    if (token) {
      logger.info("Read Gitea admin token from init file");
      return token;
    }
  }

  throw new Error(
    "No Gitea admin token found. Either set GITEA_ADMIN_TOKEN or use the gitea-init.sh entrypoint in docker-compose."
  );
}

async function loginAndCreateToken(username: string, password: string): Promise<boolean> {
  const basicAuth = Buffer.from(`${username}:${password}`).toString("base64");
  const tokenRes = await fetch(giteaUrl(`/api/v1/users/${username}/tokens`), {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `hoto-${Date.now()}`,
      scopes: ["all"],
    }),
  });

  if (!tokenRes.ok) {
    logger.warn("Gitea basic auth token creation failed", { username, status: tokenRes.status });
    return false;
  }

  const tokenData = await tokenRes.json() as { sha1: string };
  _botToken = tokenData.sha1;

  const db = getDb();
  db.run(
    "INSERT OR REPLACE INTO messaging_config (key, value) VALUES ('gitea_bot_token', ?)",
    [_botToken]
  );

  logger.info("Gitea bot token created and stored", { username });
  return true;
}

async function createBotUser(username: string, password: string): Promise<void> {
  const adminToken = await getAdminToken();

  // Check if user already exists
  const checkRes = await giteaFetch(`/api/v1/users/${username}`, {}, adminToken);

  if (checkRes.ok) {
    // User exists -- reset password so we can auth
    logger.info("Gitea bot user already exists, resetting password", { username });
    const patchRes = await giteaFetch(`/api/v1/admin/users/${username}`, {
      method: "PATCH",
      body: JSON.stringify({
        password,
        must_change_password: false,
        login_name: username,
        source_id: 0,
      }),
    }, adminToken);
    if (!patchRes.ok) {
      const body = await patchRes.text();
      logger.error("Failed to reset bot user password", { status: patchRes.status, body });
      process.exit(1);
    }
    return;
  }

  // User doesn't exist -- create it
  const createRes = await giteaFetch("/api/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      username,
      password,
      email: `${username}@hoto.local`,
      must_change_password: false,
      visibility: "public",
    }),
  }, adminToken);

  if (createRes.ok) {
    logger.info("Gitea bot user created", { username });
    return;
  }

  const body = await createRes.text();
  logger.error("Failed to create Gitea bot user", { status: createRes.status, body });
  process.exit(1);
}

async function ensureOrg(): Promise<void> {
  const org = config.giteaOrg;
  const username = config.giteaBotUser;

  const res = await giteaFetch(`/api/v1/orgs/${org}`);
  if (!res.ok) {
    const createRes = await giteaFetch("/api/v1/orgs", {
      method: "POST",
      body: JSON.stringify({
        username: org,
        visibility: "public",
        full_name: "Hoto Tasks",
      }),
    });

    if (!createRes.ok && createRes.status !== 422) {
      const body = await createRes.text();
      logger.error("Failed to create Gitea org", { org, status: createRes.status, body });
      process.exit(1);
    }
    logger.info("Gitea org created", { org });
  }

  // Ensure bot user is an owner of the org
  const memberRes = await giteaFetch(`/api/v1/orgs/${org}/members/${username}`);
  if (!memberRes.ok) {
    const addRes = await giteaFetch(`/api/v1/orgs/${org}/teams`, {
      method: "GET",
    });
    // Find the Owners team and add the bot user
    if (addRes.ok) {
      const teams = await addRes.json() as Array<{ id: number; name: string }>;
      const owners = teams.find((t) => t.name === "Owners");
      if (owners) {
        await giteaFetch(`/api/v1/teams/${owners.id}/members/${username}`, {
          method: "PUT",
        });
        logger.info("Added bot user to org Owners team", { org, username });
      }
    }
  }
}

// -- Repo Management ---------------------------------------------------------

export async function ensureGiteaRepo(repoName: string): Promise<void> {
  const org = config.giteaOrg;
  const res = await giteaFetch(`/api/v1/repos/${org}/${repoName}`);
  if (res.ok) return;

  const createRes = await giteaFetch(`/api/v1/orgs/${org}/repos`, {
    method: "POST",
    body: JSON.stringify({
      name: repoName,
      auto_init: false,
      private: false,
    }),
  });

  if (createRes.ok || createRes.status === 409) {
    logger.info("Gitea repo ready", { org, repo: repoName });
  } else {
    const body = await createRes.text();
    throw new Error(`Failed to create Gitea repo: ${createRes.status} ${body}`);
  }
}

export async function mirrorRepoToGitea(repoPath: string, repoName: string): Promise<void> {
  const { $ } = await import("bun");

  await ensureGiteaRepo(repoName);

  const giteaUrl = getGiteaRemoteUrl(repoName);

  const defaultBranchResult = await $`git -C ${repoPath} symbolic-ref --short HEAD`.nothrow().quiet();
  if (defaultBranchResult.exitCode !== 0) {
    throw new Error(`Failed to get default branch: ${defaultBranchResult.stderr.toString().trim()}`);
  }
  const defaultBranch = defaultBranchResult.stdout.toString().trim();

  const pushBranchesResult = await $`git -C ${repoPath} push ${giteaUrl} refs/heads/*:refs/heads/*`.nothrow().quiet();
  if (pushBranchesResult.exitCode !== 0) {
    throw new Error(`Failed to push branches to Gitea: ${pushBranchesResult.stderr.toString().trim()}`);
  }

  const pushTagsResult = await $`git -C ${repoPath} push ${giteaUrl} --tags`.nothrow().quiet();
  if (pushTagsResult.exitCode !== 0) {
    throw new Error(`Failed to push tags to Gitea: ${pushTagsResult.stderr.toString().trim()}`);
  }

  const org = config.giteaOrg;
  const patchRes = await giteaFetch(`/api/v1/repos/${org}/${repoName}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ default_branch: defaultBranch }),
  });
  if (!patchRes.ok) {
    throw new Error(`Failed to set default branch on Gitea: ${patchRes.status} ${await patchRes.text()}`);
  }

  const removeResult = await $`git -C ${repoPath} remote remove origin`.nothrow().quiet();
  if (removeResult.exitCode !== 0) {
    throw new Error(`Failed to remove origin remote: ${removeResult.stderr.toString().trim()}`);
  }

  const addResult = await $`git -C ${repoPath} remote add origin ${giteaUrl}`.nothrow().quiet();
  if (addResult.exitCode !== 0) {
    throw new Error(`Failed to add Gitea remote: ${addResult.stderr.toString().trim()}`);
  }

  const upstreamResult = await $`git -C ${repoPath} branch --set-upstream-to=origin/${defaultBranch} ${defaultBranch}`.nothrow().quiet();
  if (upstreamResult.exitCode !== 0) {
    throw new Error(`Failed to set upstream tracking: ${upstreamResult.stderr.toString().trim()}`);
  }
}

/**
 * If a URL points at the configured Gitea instance, rewrite it to embed bot credentials.
 * Matches on port since Gitea runs on a dedicated port and the hostname may vary
 * (0.0.0.0, localhost, gitea, etc.).
 */
export function embedGiteaCredentials(url: string): string {
  if (!config.giteaUrl || !_botToken) return url;
  try {
    const giteaBase = new URL(config.giteaUrl);
    const parsed = new URL(url);
    const giteaPort = giteaBase.port || (giteaBase.protocol === "https:" ? "443" : "80");
    const urlPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    if (giteaPort === urlPort) {
      parsed.username = config.giteaBotUser;
      parsed.password = _botToken;
      return parsed.toString();
    }
  } catch {}
  return url;
}

export function getGiteaRemoteUrl(repoName: string): string {
  const org = config.giteaOrg;
  const username = config.giteaBotUser;
  // Parse giteaUrl to embed credentials
  const url = new URL(config.giteaUrl ?? "");
  return `${url.protocol}//${username}:${_botToken}@${url.host}/${org}/${repoName}.git`;
}

// -- Pull Request Operations -------------------------------------------------

export interface GiteaPR {
  number: number;
  state: string;
  title: string;
  merged: boolean;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

export interface GiteaReview {
  id: number;
  state: string; // "APPROVED", "REQUEST_CHANGES", "COMMENT"
  body: string;
  user: { login: string };
}

export interface GiteaComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface GiteaReviewComment {
  id: number;
  body: string;
  path: string;
  line: number;
  user: { login: string };
}

export async function createPullRequest(
  repoName: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<GiteaPR> {
  const org = config.giteaOrg;
  const res = await giteaFetch(`/api/v1/repos/${org}/${repoName}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, body, head, base }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create PR: ${res.status} ${text}`);
  }

  return res.json() as Promise<GiteaPR>;
}

export async function updatePullRequest(
  repoName: string,
  prNumber: number,
  title: string,
  body: string
): Promise<GiteaPR> {
  const org = config.giteaOrg;
  const res = await giteaFetch(`/api/v1/repos/${org}/${repoName}/pulls/${prNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ title, body }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update PR: ${res.status} ${text}`);
  }

  return res.json() as Promise<GiteaPR>;
}

export async function getPullRequest(repoName: string, prNumber: number): Promise<GiteaPR> {
  const org = config.giteaOrg;
  const res = await giteaFetch(`/api/v1/repos/${org}/${repoName}/pulls/${prNumber}`);
  if (!res.ok) {
    throw new Error(`Failed to get PR #${prNumber}: ${res.status}`);
  }
  return res.json() as Promise<GiteaPR>;
}

export async function listPullRequestReviews(repoName: string, prNumber: number): Promise<GiteaReview[]> {
  const org = config.giteaOrg;
  const res = await giteaFetch(`/api/v1/repos/${org}/${repoName}/pulls/${prNumber}/reviews`);
  if (!res.ok) return [];
  return res.json() as Promise<GiteaReview[]>;
}

export async function listReviewComments(
  repoName: string,
  prNumber: number,
  reviewId: number
): Promise<GiteaReviewComment[]> {
  const org = config.giteaOrg;
  const res = await giteaFetch(
    `/api/v1/repos/${org}/${repoName}/pulls/${prNumber}/reviews/${reviewId}/comments`
  );
  if (!res.ok) return [];
  return res.json() as Promise<GiteaReviewComment[]>;
}

export async function listPullRequestComments(repoName: string, prNumber: number): Promise<GiteaComment[]> {
  const org = config.giteaOrg;
  const res = await giteaFetch(`/api/v1/repos/${org}/${repoName}/issues/${prNumber}/comments`);
  if (!res.ok) return [];
  return res.json() as Promise<GiteaComment[]>;
}

export async function commentOnPullRequest(repoName: string, prNumber: number, body: string): Promise<void> {
  const org = config.giteaOrg;
  await giteaFetch(`/api/v1/repos/${org}/${repoName}/issues/${prNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export function isGiteaConfigured(): boolean {
  return !!config.giteaUrl && _botToken !== null;
}

export function getGiteaBotToken(): string | null {
  return _botToken;
}
