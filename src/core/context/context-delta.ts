import { contentIdentity } from "./context-snapshot.js";

export type ExactDelta = {
  kind: "replace";
  content: string;
  contentIdentity: string;
};

export function createExactDelta(_previous: string, current: string): ExactDelta {
  if (typeof current !== "string") throw new TypeError("current content is required");
  return { kind: "replace", content: current, contentIdentity: contentIdentity(current) };
}

export function applyDelta(_previous: string, delta: ExactDelta): string {
  if (delta.kind !== "replace" || contentIdentity(delta.content) !== delta.contentIdentity) throw new TypeError("delta content identity is invalid");
  return delta.content;
}
