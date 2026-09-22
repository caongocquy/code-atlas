export function retryWorkflowStep(taskId: string, attempts: number): string {
  return `${taskId}:${attempts}`;
}
