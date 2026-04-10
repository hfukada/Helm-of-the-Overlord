import type { Repo } from "../shared/types";
import { logger } from "../shared/logger";

/**
 * Extract per-repo plan excerpts from a finalized multi-repo plan.
 *
 * The finalized plan uses [repo-name] prefixes on execution plan steps.
 * This function splits the plan into per-repo excerpts:
 * - The Summary section goes to ALL repos
 * - Steps prefixed with [repo-name] go to that repo
 * - Steps without a prefix go to ALL repos (cross-cutting)
 */
export function extractRepoExcerpts(
  plan: string,
  repos: Repo[]
): Map<string, string> {
  const repoNames = new Set(repos.map((r) => r.name));
  const excerpts = new Map<string, string>();

  // Split plan into Summary and Execution Plan sections
  const execIdx = plan.search(/^#{1,3}\s*Execution Plan/mi);
  const summary = execIdx >= 0 ? plan.slice(0, execIdx).trim() : "";
  const execSection = execIdx >= 0 ? plan.slice(execIdx) : plan;

  // Parse execution plan steps
  // Matches numbered steps like "1. [ ] [repo-name] ..." or "### Step 1 -- [repo-name]"
  const lines = execSection.split("\n");

  // Accumulate steps per repo
  const repoSteps = new Map<string, string[]>();
  const sharedSteps: string[] = [];

  for (const name of repoNames) {
    repoSteps.set(name, []);
  }

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
    // Detect step start: numbered list item or ### Step header
    const stepMatch = line.match(/^(?:\d+\.\s*(?:\[[ x]\]\s*)?|#{1,3}\s*Step\s+\d+)/i);

    if (stepMatch) {
      flushStep();
      inStep = true;

      // Check for [repo-name] tag -- match any [word] that's a known repo name
      // Skip checkbox markers like [ ] and [x]
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
      // Continuation of current step (indented or non-step content)
      if (line.trim() === "" || line.startsWith("  ") || line.startsWith("\t") || line.startsWith("```") || !line.match(/^(?:\d+\.|#{1,3}\s)/)) {
        currentStep.push(line);
      } else {
        // New non-step content -- flush
        flushStep();
        inStep = false;
        sharedSteps.push(line);
      }
    } else {
      // Non-step content in the execution plan section (headers, etc.)
      sharedSteps.push(line);
    }
  }
  flushStep();

  // Build excerpts per repo
  for (const repo of repos) {
    const parts: string[] = [];

    // Always include summary
    if (summary) {
      parts.push(summary);
      parts.push("");
    }

    parts.push("### Execution Plan");
    parts.push("");

    // Shared steps first
    if (sharedSteps.length > 0) {
      const sharedText = sharedSteps.join("\n").trim();
      if (sharedText) {
        parts.push(sharedText);
        parts.push("");
      }
    }

    // Repo-specific steps
    const steps = repoSteps.get(repo.name) ?? [];
    if (steps.length > 0) {
      parts.push(steps.join("\n\n"));
    }

    const excerpt = parts.join("\n").trim();
    excerpts.set(repo.name, excerpt);

    logger.info("Extracted plan excerpt for repo", {
      repo: repo.name,
      totalSteps: steps.length,
      sharedSteps: sharedSteps.length,
      excerptLength: excerpt.length,
    });
  }

  return excerpts;
}
