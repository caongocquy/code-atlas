import type { ContextSubject } from "./context.types.js";

export type TaskContextAnchor =
  | { kind: "file"; path: string }
  | { kind: "symbol"; path?: string; name: string };

export type CompileTaskContextInput = {
  task: string;
  repoPath?: string;
  anchors?: TaskContextAnchor[];
  changedPaths?: string[];
  budget?: { maxItems?: number; maxEstimatedTokens?: number };
  detail?: "compact" | "full";
};

export type NormalizedTaskContextInput = {
  task: string;
  anchors: TaskContextAnchor[];
  changedPaths: string[];
};

export type TaskContextPriority = "required" | "supporting" | "optional";

export type TaskContextEvidence =
  | { kind: "explicit_anchor"; anchor: TaskContextAnchor }
  | { kind: "explicit_changed_path"; path: string }
  | { kind: "task_exact_resolution"; query: string; resolution: "file" | "symbol" }
  | { kind: "diagnostic"; message: string };

export type TaskContextCandidate = {
  subject?: ContextSubject;
  query?: string;
  priorityHint?: TaskContextPriority;
  evidence: TaskContextEvidence[];
  sourceRanks: Partial<Record<TaskContextEvidence["kind"], number>>;
  estimatedTokens?: number;
  exact: boolean;
};
