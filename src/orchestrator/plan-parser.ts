/**
 * Parse a multi-repo plan output into per-repo plan sections.
 *
 * Looks for `## [repo-name]` headers in the plan output.
 * If none found (single-repo plan), returns the entire plan under the first repo name.
 */
export function parseMultiRepoPlan(
  planOutput: string,
  repoNames: string[]
): Map<string, string> {
  const result = new Map<string, string>();

  // Try to split by ## [repo-name] headers
  const repoSet = new Set(repoNames);
  const headerPattern = /^##\s+\[([^\]]+)\]\s*$/gm;
  const matches: Array<{ name: string; index: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(planOutput)) !== null) {
    const name = match[1].trim();
    if (repoSet.has(name)) {
      matches.push({ name, index: match.index });
    }
  }

  if (matches.length === 0) {
    // No per-repo headers found -- entire plan applies to all repos (or single repo)
    if (repoNames.length === 1) {
      result.set(repoNames[0], planOutput);
    } else {
      // Multi-repo but no headers -- give the whole plan to each repo
      // (the implement agent will figure out what applies)
      for (const name of repoNames) {
        result.set(name, planOutput);
      }
    }
    return result;
  }

  // Extract the summary section (everything before the first repo header)
  const summary = planOutput.slice(0, matches[0].index).trim();

  // Extract per-repo sections
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : planOutput.length;
    const section = planOutput.slice(start, end).trim();

    // Prepend the summary so each repo's plan has the full context
    const fullSection = summary ? `${summary}\n\n${section}` : section;
    result.set(matches[i].name, fullSection);
  }

  return result;
}
