import { logger } from "./logger";

export async function loadDotenv(path: string): Promise<void> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return;
    const text = await file.text();
    let count = 0;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!key) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
        count++;
      }
    }
    logger.info("Loaded .env file", { path, count });
  } catch (e) {
    logger.warn("Failed to read .env file", { path, error: String(e) });
  }
}
