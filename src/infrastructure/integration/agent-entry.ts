export const CODE_ATLAS_COMMAND = "code-atlas";
export const CODE_ATLAS_ARGS = ["mcp"];
export const CODE_ATLAS_NAME = "code-atlas";

export function isCodeAtlasCommand(command: unknown, args: unknown): boolean {
  return command === CODE_ATLAS_COMMAND
    && Array.isArray(args)
    && args.length === CODE_ATLAS_ARGS.length
    && args.every((value, index) => value === CODE_ATLAS_ARGS[index]);
}
