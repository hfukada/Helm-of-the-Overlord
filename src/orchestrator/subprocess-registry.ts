import type { Subprocess } from "bun";
import { logger } from "../shared/logger";

// Maps taskId -> set of active subprocess instances
const registry = new Map<string, Set<Subprocess>>();

export function registerSubprocess(taskId: string, proc: Subprocess): void {
  let procs = registry.get(taskId);
  if (!procs) {
    procs = new Set();
    registry.set(taskId, procs);
  }
  procs.add(proc);
}

export function unregisterSubprocess(taskId: string, proc: Subprocess): void {
  const procs = registry.get(taskId);
  if (!procs) return;
  procs.delete(proc);
  if (procs.size === 0) {
    registry.delete(taskId);
  }
}

export function killTaskSubprocesses(taskId: string): void {
  const procs = registry.get(taskId);
  if (!procs || procs.size === 0) return;

  logger.info("Killing subprocesses for task", { taskId, count: procs.size });
  for (const proc of procs) {
    try {
      proc.kill();
    } catch (err) {
      logger.warn("Failed to kill subprocess", { taskId, error: String(err) });
    }
  }
  registry.delete(taskId);
}
