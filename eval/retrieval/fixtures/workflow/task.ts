export interface TaskPolicy {
  allow(taskId: string): boolean;
}

export class StrictTaskPolicy implements TaskPolicy {
  allow(taskId: string): boolean {
    return taskId.length > 0;
  }
}

export function executeTask(taskId: string, policy: TaskPolicy): string {
  if (!policy.allow(taskId)) throw new Error("task rejected");
  return `done:${taskId}`;
}

export function runTask(taskId: string): string {
  return `task:${taskId}`;
}

export function runTaskWithPolicy(taskId: string, policy: TaskPolicy): string {
  return executeTask(taskId, policy);
}
