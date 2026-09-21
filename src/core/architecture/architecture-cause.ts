import type { ArchitectureCause } from "./architecture-drift.types.js";

export function attributeArchitectureCause(graphChanged: boolean, policyChanged: boolean): ArchitectureCause {
  if (graphChanged && policyChanged) return "both";
  if (policyChanged) return "policy_change";
  return "code_change";
}
