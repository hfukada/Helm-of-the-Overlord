import { config } from "../shared/config";
import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";

let _botToken: string | null = null;

function giteaUrl(path: string): string {
  return `${config.giteaUrl}${path}`;
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

  // Check DB for existing token
  const db = getDb();
  const stored = db.query("SELECT value FROM messaging_config WHERE key = 'gitea_bot_token'").get() as { value: string } | null;

  if (stored) {
    _botToken = stored.value;
    // Verify token works
    try {
      const res = await giteaFetch("/api/v1/user");
      if (res.ok) {
        logger.info("Gitea client initialized with stored token");
        await ensureOrg();
        return;
      }
    } catch {}
    // Token invalid, re-create
    _botToken = null;
  }

  // Create bot user and get token
  await createBotUser();
  await ensureOrg();
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

async function createBotUser(): Promise<void> {
  const adminToken = config.giteaAdminToken;
  if (!adminToken) {
    throw new Error("GITEA_ADMIN_TOKEN required for initial bot user creation");
  }

  const username = config.giteaBotUser;
  const password = config.giteaBotPassword;

  // Try to create the user
  const createRes = await giteaFetch("/api/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      username,
      password,
      email: `${username}@localhost`,
      must_change_password: false,
      visibility: "public",
    }),
  }, adminToken);

  if (createRes.ok) {
    logger.info("Gitea bot user created", { username });
  } else if (createRes.status === 422) {
    // User already exists
    logger.info("Gitea bot user already exists", { username });
  } else {
    const body = await createRes.text();
    throw new Error(`Failed to create Gitea bot user: ${createRes.status} ${body}`);
  }

  // Create an API token for the bot using basic auth
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
    const body = await tokenRes.text();
    throw new Error(`Failed to create Gitea bot token: ${tokenRes.status} ${body}`);
  }

  const tokenData = await tokenRes.json() as { sha1: string };
  _botToken = tokenData.sha1;

  // Store token in DB
  const db = getDb();
  db.run(
    "INSERT OR REPLACE INTO messaging_config (key, value) VALUES ('gitea_bot_token', ?)",
    [_botToken]
  );

  logger.info("Gitea bot token created and stored");
}

async function ensureOrg(): Promise<void> {
  const org = config.giteaOrg;
  const res = await giteaFetch(`/api/v1/orgs/${org}`);
  if (res.ok) return;

  const createRes = await giteaFetch("/api/v1/orgs", {
    method: "POST",
    body: JSON.stringify({
      username: org,
      visibility: "public",
      full_name: "Hoto Tasks",
    }),
  });

  if (createRes.ok || createRes.status === 422) {
    logger.info("Gitea org ready", { org });
  } else {
    const body = await createRes.text();
    logger.warn("Failed to create Gitea org", { org, status: createRes.status, body });
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

export function getGiteaRemoteUrl(repoName: string): string {
  const org = config.giteaOrg;
  const username = config.giteaBotUser;
  // Parse giteaUrl to embed credentials
  const url = new URL(config.giteaUrl!);
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
