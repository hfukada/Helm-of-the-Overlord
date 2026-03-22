import { readFile } from "node:fs/promises";
import { join } from "node:path";

const TEMPLATE_DIR = join(import.meta.dir, "templates");
const cache = new Map<string, string>();

async function loadTemplate(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;

  const filePath = join(TEMPLATE_DIR, `${name}.md`);
  const content = await readFile(filePath, "utf-8");
  cache.set(name, content);
  return content;
}

function interpolate(
  template: string,
  vars: Record<string, string | undefined>
): string {
  // Process {{#if var}}...{{/if}} conditional blocks
  let result = template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, varName: string, block: string) => {
      const value = vars[varName];
      return value ? block : "";
    }
  );

  // Process {{variable}} interpolation
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
    return vars[varName] ?? "";
  });

  return result;
}

export async function renderTemplate(
  name: string,
  vars: Record<string, string | undefined> = {}
): Promise<string> {
  const template = await loadTemplate(name);
  return interpolate(template, vars);
}

export function clearTemplateCache(): void {
  cache.clear();
}
