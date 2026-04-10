import { Hono } from "hono";
import { logger } from "../../shared/logger";
import pkg from "../../../package.json";

const version = new Hono();

version.get("/", (c) => {
  // In Docker, HOTO_GIT_COMMIT and HOTO_GIT_DATETIME are baked in at build time
  // via ARG/ENV in the Dockerfile. Use them when present.
  const envCommit = process.env.HOTO_GIT_COMMIT;
  const envDatetime = process.env.HOTO_GIT_DATETIME;

  if (envCommit && envDatetime) {
    return c.json({ version: pkg.version, commit: envCommit, datetime: envDatetime });
  }

  // Fallback: attempt git log for local dev (bun run src/index.ts daemon start).
  // This path is unreachable inside Docker because .git is not copied into the image.
  const result = Bun.spawnSync(
    ["git", "log", "-1", "--format=%H %cI"],
    { cwd: new URL("../../..", import.meta.url).pathname }
  );

  if (result.exitCode !== 0) {
    logger.warn("git log failed, commit info unavailable", { exitCode: result.exitCode });
    return c.json({ version: pkg.version, commit: null, datetime: null });
  }

  const stdout = result.stdout.toString().trim();
  const spaceIdx = stdout.indexOf(" ");

  if (spaceIdx === -1) {
    logger.warn("git log failed, commit info unavailable", { exitCode: result.exitCode });
    return c.json({ version: pkg.version, commit: null, datetime: null });
  }

  return c.json({
    version: pkg.version,
    commit: stdout.slice(0, spaceIdx),
    datetime: stdout.slice(spaceIdx + 1),
  });
});

export { version };
