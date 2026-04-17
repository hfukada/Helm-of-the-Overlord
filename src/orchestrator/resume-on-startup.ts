/**
 * Resume interrupted tasks on daemon startup.
 *
 * When the daemon restarts (container rebuild, crash, etc.), tasks that were
 * actively running are left in non-terminal statuses. This module finds them
 * and restarts them from the appropriate phase using the existing
 * restartTaskPhase / restartChildTaskPhase machinery.
 */

import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";
import { config } from "../shared/config";
import { findResumePoint } from "./resume-utils";
import type { BlueprintState } from "../shared/types";

/** Statuses that indicate a parent task was actively running when the daemon died. */
const ACTIVE_PARENT_STATUSES = [
  "pending", "indexing", "scoping",
  "planning", "scrutinizing", "replanning", "finalizing_plan",
  "spawning_children", "waiting_for_children",
  "implementing", "linting", "fix_linting", "ci_running", "ci_fixing",
  "resuming",
];

/** Statuses that indicate a child task was actively running. */
const ACTIVE_CHILD_STATUSES = [
  "pending", "implementing", "linting", "fix_linting",
  "ci_running", "ci_fixing", "resuming",
];

/** Statuses where the parent task should not be restarted (children handle themselves). */
const PARENT_SKIP_STATUSES = new Set(["waiting_for_children"]);

/** Early phases cheap enough to restart from scratch. */
const EARLY_PHASES = new Set(["pending", "indexing", "scoping"]);

/**
 * Maps task status values to the blueprint node to restart from when no
 * blueprint_state is available. "resuming" is a transient meta-state; without
 * blueprint_state the prior phase is unknowable, so it falls back to "index".
 */
const STATUS_TO_PHASE: Record<string, string> = {
  planning:        "plan",
  scrutinizing:    "scrutinize",
  replanning:      "plan_again",
  finalizing_plan: "finalize_plan",
  implementing:    "implement",
  linting:         "lint",
  fix_linting:     "fix_lint",
  ci_running:      "ci",
  ci_fixing:       "fix_ci",
  resuming:        "index",
};

/** Delay between parent task resumptions to avoid API rate limits. */
const STAGGER_MS = 2000;

function parseBlueprint(raw: string | null): BlueprintState | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BlueprintState;
  } catch {
    return null;
  }
}

function phaseForParentStatus(
  status: string,
  blueprintState: BlueprintState | null,
): string {
  if (EARLY_PHASES.has(status)) return "index";
  if (status === "spawning_children") return "finalize_plan";

  // For planning/execution phases, use findResumePoint if we have state
  if (blueprintState) {
    const { node } = findResumePoint(blueprintState);
    return node;
  }

  // No blueprint state saved -- derive phase from status, or restart from scratch
  return STATUS_TO_PHASE[status] ?? "index";
}

function phaseForChildStatus(
  blueprintState: BlueprintState | null,
): string {
  if (blueprintState) {
    const { node } = findResumePoint(blueprintState);
    return node;
  }
  return "implement";
}

/** Dependency injection for testing. */
export interface ResumeHandlers {
  restartTaskPhase: (taskId: string, phase: string) => Promise<void>;
  restartChildTaskPhase: (taskId: string, childId: string, phase: string) => Promise<void>;
  staggerMs?: number;
}

export async function resumeInterruptedTasks(overrides?: ResumeHandlers): Promise<void> {
  if (!config.autoResumeOnStartup) {
    logger.info("Auto-resume disabled (HOTO_AUTO_RESUME=false)");
    return;
  }

  const db = getDb();

  // Find interrupted parent tasks
  const placeholders = ACTIVE_PARENT_STATUSES.map(() => "?").join(", ");
  const parentTasks = db.query(
    `SELECT id, status, blueprint_state FROM tasks WHERE status IN (${placeholders})`
  ).all(...ACTIVE_PARENT_STATUSES) as Array<{
    id: string;
    status: string;
    blueprint_state: string | null;
  }>;

  // Find interrupted child tasks
  const childPlaceholders = ACTIVE_CHILD_STATUSES.map(() => "?").join(", ");
  const childTasks = db.query(
    `SELECT id, parent_task_id, status, blueprint_state FROM child_tasks WHERE status IN (${childPlaceholders})`
  ).all(...ACTIVE_CHILD_STATUSES) as Array<{
    id: string;
    parent_task_id: string;
    status: string;
    blueprint_state: string | null;
  }>;

  if (parentTasks.length === 0 && childTasks.length === 0) {
    logger.info("No interrupted tasks to resume");
    return;
  }

  logger.info("Found interrupted tasks to resume", {
    parentCount: parentTasks.length,
    childCount: childTasks.length,
  });

  // Use overrides if provided (testing), otherwise lazy-import real implementations
  let restartTaskPhase: (taskId: string, phase: string) => Promise<void>;
  let restartChildTaskPhase: (taskId: string, childId: string, phase: string) => Promise<void>;
  const staggerMs = overrides?.staggerMs ?? STAGGER_MS;

  if (overrides) {
    restartTaskPhase = overrides.restartTaskPhase;
    restartChildTaskPhase = overrides.restartChildTaskPhase;
  } else {
    const taskRunner = await import("./task-runner");
    const childRunner = await import("./child-task-runner");
    restartTaskPhase = taskRunner.restartTaskPhase;
    restartChildTaskPhase = childRunner.restartChildTaskPhase;
  }

  const { getMessagingManager } = await import("../messaging/manager");
  const manager = overrides ? null : getMessagingManager();

  // Resume parent tasks (staggered)
  for (const task of parentTasks) {
    if (PARENT_SKIP_STATUSES.has(task.status)) {
      // waiting_for_children -- children will be resumed below
      logger.info("Skipping parent resume (children will be resumed)", {
        taskId: task.id,
        status: task.status,
      });
      continue;
    }

    const bp = parseBlueprint(task.blueprint_state);
    const phase = phaseForParentStatus(task.status, bp);

    logger.info("Resuming parent task", {
      taskId: task.id,
      previousStatus: task.status,
      restartPhase: phase,
    });

    if (manager) {
      manager.notifyAgentOutput(
        task.id,
        `Resuming task after daemon restart (restarting from ${phase} phase)`,
      ).catch(() => {});
    }

    try {
      await restartTaskPhase(task.id, phase);
    } catch (err) {
      logger.error("Failed to resume parent task", {
        taskId: task.id,
        phase,
        error: String(err),
      });
    }

    // Stagger to avoid overwhelming the API
    if (staggerMs > 0) {
      await new Promise((r) => setTimeout(r, staggerMs));
    }
  }

  // Resume child tasks
  // Group by parent to check parent status
  const parentStatusCache = new Map<string, string>();
  for (const child of childTasks) {
    let parentStatus = parentStatusCache.get(child.parent_task_id);
    if (!parentStatus) {
      const row = db.query("SELECT status FROM tasks WHERE id = ?").get(
        child.parent_task_id,
      ) as { status: string } | null;
      parentStatus = row?.status ?? "unknown";
      parentStatusCache.set(child.parent_task_id, parentStatus);
    }

    if (parentStatus === "cancelled" || parentStatus === "failed") {
      logger.info("Skipping child resume (parent is terminal)", {
        childId: child.id,
        parentTaskId: child.parent_task_id,
        parentStatus,
      });
      continue;
    }

    const bp = parseBlueprint(child.blueprint_state);
    const phase = phaseForChildStatus(bp);

    logger.info("Resuming child task", {
      childId: child.id,
      parentTaskId: child.parent_task_id,
      previousStatus: child.status,
      restartPhase: phase,
    });

    try {
      await restartChildTaskPhase(child.parent_task_id, child.id, phase);
    } catch (err) {
      logger.error("Failed to resume child task", {
        childId: child.id,
        parentTaskId: child.parent_task_id,
        phase,
        error: String(err),
      });
    }
  }

  logger.info("Task resumption complete");

  if (!overrides) {
    import("../projects/runner").then(({ resumeProjects }) => {
      resumeProjects().catch((err) =>
        logger.error("resumeProjects failed on startup", { error: String(err) })
      );
    }).catch(() => {});
  }
}
