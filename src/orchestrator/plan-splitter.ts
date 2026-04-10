import type { Repo } from "../shared/types";
import { logger } from "../shared/logger";

/**
 * Extract per-repo plan excerpts from a finalized multi-repo plan.
 *
 * Supports two plan formats:
 *
 * 1. **Structured (preferred)**: The plan has a "### Per-Repo Plans" section
 *    with `#### [repo-name]` subsections. Each subsection is a complete,
 *    self-contained plan for that repo.
 *
 * 2. **Legacy (fallback)**: The plan has an "### Execution Plan" section with
 *    numbered steps prefixed by `[repo-name]`. This function filters steps per repo.
 *
 * Each child gets:
 * - The Summary section (shared)
 * - The Cross-Repo Context section (shared, if present)
 * - Their repo-specific plan section
 */
export function extractRepoExcerpts(
  plan: string,
  repos: Repo[]
): Map<string, string> {
  const repoNames = new Set(repos.map((r) => r.name));

  // Extract common sections
  const summary = extractSection(plan, /^#{1,3}\s*Summary\b/mi);
  const crossRepoContext = extractSection(plan, /^#{1,3}\s*Cross-Repo Context\b/mi);

  // Try structured format first
  const structured = extractStructuredRepoSections(plan, repoNames);

  if (structured.size > 0) {
    return buildExcerptsFromStructured(repos, summary, crossRepoContext, structured);
  }

  // Fall back to legacy tagged-step format
  return buildExcerptsFromLegacy(plan, repos, summary, crossRepoContext);
}

/** Extract a named section (### Section Name ...) up to the next section header. */
function extractSection(plan: string, headerPattern: RegExp): string {
  const lines = plan.split("\n");
  const startIdx = lines.findIndex((l) => headerPattern.test(l));
  if (startIdx < 0) return "";

  const result: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    // Stop at next header of same or lower depth
    if (/^#{1,3}\s/.test(lines[i])) break;
    result.push(lines[i]);
  }
  return result.join("\n").trim();
}

/**
 * Extract `#### [repo-name]` sections from the Per-Repo Plans block.
 * Returns a map of repo name -> section text.
 */
function extractStructuredRepoSections(plan: string, repoNames: Set<string>): Map<string, string> {
  const sections = new Map<string, string>();

  // Find the "### Per-Repo Plans" header
  const lines = plan.split("\n");
  const perRepoIdx = lines.findIndex((l) => /^#{1,3}\s*Per-Repo Plans\b/i.test(l));
  if (perRepoIdx < 0) return sections;

  // Scan for #### [repo-name] subsections
  let currentRepo: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentRepo && currentLines.length > 0) {
      sections.set(currentRepo, currentLines.join("\n").trim());
    }
    currentLines = [];
    currentRepo = null;
  };

  for (let i = perRepoIdx + 1; i < lines.length; i++) {
    const line = lines[i];

    // Stop at a top-level ### header (new top-level section)
    if (/^#{1,3}\s/.test(line) && !/^####\s/.test(line)) {
      flush();
      break;
    }

    // New repo subsection
    const subMatch = line.match(/^####\s*\[?([^\]\s]+)\]?\s*$/);
    if (subMatch) {
      flush();
      const candidate = subMatch[1];
      if (repoNames.has(candidate)) {
        currentRepo = candidate;
      }
      continue;
    }

    if (currentRepo) {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

function buildExcerptsFromStructured(
  repos: Repo[],
  summary: string,
  crossRepoContext: string,
  sections: Map<string, string>,
): Map<string, string> {
  const excerpts = new Map<string, string>();

  for (const repo of repos) {
    const parts: string[] = [];
    if (summary) { parts.push(summary); parts.push(""); }
    if (crossRepoContext) { parts.push(crossRepoContext); parts.push(""); }

    const repoSection = sections.get(repo.name);
    if (repoSection) {
      parts.push("### Execution Plan");
      parts.push("");
      parts.push(repoSection);
    } else {
      // No section for this repo -- fall back to just the summary (unlikely)
      logger.warn("No structured section found for repo in plan", { repo: repo.name });
    }

    const excerpt = parts.join("\n").trim();
    excerpts.set(repo.name, excerpt);

    logger.info("Extracted structured plan excerpt for repo", {
      repo: repo.name,
      excerptLength: excerpt.length,
    });
  }

  return excerpts;
}

function buildExcerptsFromLegacy(
  plan: string,
  repos: Repo[],
  summary: string,
  crossRepoContext: string,
): Map<string, string> {
  const repoNames = new Set(repos.map((r) => r.name));
  const excerpts = new Map<string, string>();

  // Split plan at Execution Plan header
  const execIdx = plan.search(/^#{1,3}\s*Execution Plan/mi);
  const execSection = execIdx >= 0 ? plan.slice(execIdx) : plan;

  const lines = execSection.split("\n");

  const repoSteps = new Map<string, string[]>();
  const sharedSteps: string[] = [];
  for (const name of repoNames) repoSteps.set(name, []);

  let currentStep: string[] = [];
  let currentRepo: string | null = null;
  let inStep = false;

  const flushStep = () => {
    if (currentStep.length === 0) return;
    const stepText = currentStep.join("\n");
    if (currentRepo && repoSteps.has(currentRepo)) {
      repoSteps.get(currentRepo)?.push(stepText);
    } else {
      sharedSteps.push(stepText);
    }
    currentStep = [];
    currentRepo = null;
  };

  for (const line of lines) {
    const stepMatch = line.match(/^(?:\d+\.\s*(?:\[[ x]\]\s*)?|#{1,3}\s*Step\s+\d+)/i);

    if (stepMatch) {
      flushStep();
      inStep = true;

      const allBrackets = line.matchAll(/\[([^\]]+)\]/g);
      for (const m of allBrackets) {
        const candidate = m[1].trim();
        if (candidate !== "" && candidate !== " " && candidate !== "x" && repoNames.has(candidate)) {
          currentRepo = candidate;
          break;
        }
      }
      currentStep.push(line);
    } else if (inStep) {
      if (line.trim() === "" || line.startsWith("  ") || line.startsWith("\t") || line.startsWith("```") || !line.match(/^(?:\d+\.|#{1,3}\s)/)) {
        currentStep.push(line);
      } else {
        flushStep();
        inStep = false;
        sharedSteps.push(line);
      }
    } else {
      sharedSteps.push(line);
    }
  }
  flushStep();

  for (const repo of repos) {
    const parts: string[] = [];
    if (summary) { parts.push(summary); parts.push(""); }
    if (crossRepoContext) { parts.push(crossRepoContext); parts.push(""); }

    parts.push("### Execution Plan");
    parts.push("");

    if (sharedSteps.length > 0) {
      const sharedText = sharedSteps.join("\n").trim();
      if (sharedText) { parts.push(sharedText); parts.push(""); }
    }

    const steps = repoSteps.get(repo.name) ?? [];
    if (steps.length > 0) parts.push(steps.join("\n\n"));

    const excerpt = parts.join("\n").trim();
    excerpts.set(repo.name, excerpt);

    logger.info("Extracted legacy plan excerpt for repo", {
      repo: repo.name,
      totalSteps: steps.length,
      sharedSteps: sharedSteps.length,
      excerptLength: excerpt.length,
    });
  }

  return excerpts;
}
