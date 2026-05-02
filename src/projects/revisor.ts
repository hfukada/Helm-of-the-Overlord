import type { Project, ProjectMilestone } from "../shared/types";
import { logger } from "../shared/logger";
import { renderTemplate } from "../prompts/loader";
import { collectTaskFeedback, renderFeedback } from "./feedback";

interface RevisorResponse {
  rationale: string;
  changes: "none" | "revised";
  milestones: Array<{ title: string; description: string; files_estimate: number }>;
}

export interface RevisionResult {
  /** Replacement list for milestones AFTER the just-completed index, in order. */
  remainingMilestones: ProjectMilestone[];
  /** Short note from the revisor explaining what it did. */
  rationale: string;
  /** Whether the revisor changed anything. */
  changed: boolean;
}

/**
 * Run between project milestones: gather feedback from the just-completed task
 * and decide whether the remaining milestone plan should be adjusted.
 *
 * Returns null if the revision step itself fails (caller should proceed
 * unchanged in that case -- never block project advancement on revision).
 */
export async function reviseRemainingMilestones(
  project: Project,
  completedTaskId: string,
  completedIndex: number,
  mcpConfigPath: string,
): Promise<RevisionResult | null> {
  const feedback = await collectTaskFeedback(completedTaskId);
  const renderedFeedback = renderFeedback(feedback);
  const hasFeedback = renderedFeedback.length > 0;

  const completed = project.milestones[completedIndex];
  if (!completed) {
    logger.warn("Revisor: completed milestone index out of range", {
      projectId: project.id,
      completedIndex,
      milestoneCount: project.milestones.length,
    });
    return null;
  }

  const milestoneList = project.milestones
    .map((m, i) => {
      const marker = m.completed ? "[x]" : "[ ]";
      const tag = i === completedIndex ? " (just completed)" : "";
      return `${i + 1}. ${marker} ${m.title}${tag}\n   ${m.description}`;
    })
    .join("\n");

  const prompt = await renderTemplate("revise-milestones", {
    projectTitle: project.title,
    projectDescription: project.description,
    milestoneList,
    completedIndex: String(completedIndex),
    completedTitle: completed.title,
    completedDescription: completed.description,
    feedback: hasFeedback ? renderedFeedback : undefined,
    noFeedback: hasFeedback ? undefined : "1",
  });

  const { claudeJSON } = await import("../shared/claude-cli");
  let claudeResult: Awaited<ReturnType<typeof claudeJSON>>;
  try {
    claudeResult = await claudeJSON({ prompt, mcpConfigPath });
  } catch (err) {
    logger.warn("Revisor claude call threw", { projectId: project.id, error: String(err) });
    return null;
  }

  if (claudeResult.error) {
    logger.warn("Revisor claude call returned error", { projectId: project.id, error: claudeResult.error });
    return null;
  }

  const parsed = parseRevisorResponse(claudeResult.text);
  if (!parsed) {
    logger.warn("Revisor returned unparseable response", {
      projectId: project.id,
      preview: claudeResult.text.slice(0, 200),
    });
    return null;
  }

  if (parsed.changes === "none") {
    return {
      remainingMilestones: project.milestones.slice(completedIndex + 1),
      rationale: parsed.rationale,
      changed: false,
    };
  }

  // Build new ProjectMilestone entries for the replacement tail. Index is
  // assigned later when we splice into the project array.
  const remaining: ProjectMilestone[] = parsed.milestones.map((m, i) => ({
    index: completedIndex + 1 + i,
    title: m.title,
    description: m.description,
    files_estimate: m.files_estimate,
    task_id: null,
    completed: false,
  }));

  return {
    remainingMilestones: remaining,
    rationale: parsed.rationale,
    changed: true,
  };
}

export function parseRevisorResponse(text: string): RevisorResponse | null {
  // Try direct JSON first.
  const raw = text.trim();
  try {
    return validate(JSON.parse(raw));
  } catch {}

  // Try fenced JSON block.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return validate(JSON.parse(fenced[1].trim()));
    } catch {}
  }

  return null;
}

function validate(obj: unknown): RevisorResponse | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.rationale !== "string") return null;
  if (o.changes !== "none" && o.changes !== "revised") return null;
  if (!Array.isArray(o.milestones)) return null;
  for (const m of o.milestones) {
    if (!m || typeof m !== "object") return null;
    const mm = m as Record<string, unknown>;
    if (typeof mm.title !== "string") return null;
    if (typeof mm.description !== "string") return null;
    if (typeof mm.files_estimate !== "number") return null;
  }
  return o as unknown as RevisorResponse;
}
