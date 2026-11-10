import { renamedTarget } from "./reexport.js";

export function viaAlias(): number {
  return renamedTarget();
}
