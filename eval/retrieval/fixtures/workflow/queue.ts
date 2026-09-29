import { executeTask as dispatchTask, TaskPolicy } from "./task.js";

export function submitWorkflow(taskId: string, policy: TaskPolicy): string {
  return dispatchTask(taskId, policy);
}

export function queueTask(taskId: string): string {
  return `queued:${taskId}`;
}
