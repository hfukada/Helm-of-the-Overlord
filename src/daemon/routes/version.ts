import { Hono } from "hono";
import { logger } from "../../shared/logger";
import pkg from "../../../package.json";

const version = new Hono();

version.get("/", (c) => {
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
