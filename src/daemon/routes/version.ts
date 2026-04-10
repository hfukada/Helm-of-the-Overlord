import { Hono } from "hono";

const version = new Hono();

version.get("/", (c) => {
  const result = Bun.spawnSync(
    ["git", "log", "-1", "--format=%H %cI"],
    { cwd: new URL("../../..", import.meta.url).pathname }
  );
  if (result.exitCode !== 0) {
    return c.json({ error: "git command failed" }, 500);
  }
  const stdout = result.stdout.toString().trim();
  const spaceIdx = stdout.indexOf(" ");
  if (spaceIdx === -1) {
    return c.json({ error: "unexpected git output" }, 500);
  }
  return c.json({
    commit: stdout.slice(0, spaceIdx),
    datetime: stdout.slice(spaceIdx + 1),
  });
});

export { version };
