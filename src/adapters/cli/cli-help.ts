type HelpGroup = {
  title: string;
  commands: Array<[string, string]>;
};

const groups: HelpGroup[] = [
  {
    title: "Repository",
    commands: [
      ["init [path]", "Initialize and optionally index a repository"],
      ["index [path]", "Build the graph and lexical indexes"],
      ["sync [path]", "Update indexes from repository changes"],
      ["status [path]", "Show repository and capability status"],
      ["context-read [path]", "Read a file with explicit context reuse"],
    ],
  },
  {
    title: "Change Intelligence",
    commands: [
      ["inspect-change [path]", "Inspect changed and affected symbols"],
      ["affected-tests [path]", "Find tests affected by a change"],
      ["explain-incomplete [path]", "Explain incomplete graph evidence"],
      ["graph-delta [path]", "Show added and removed graph edges"],
      ["architecture-drift [path]", "Check changes against architecture rules"],
      ["gate [path]", "Evaluate change-quality gates"],
    ],
  },
  {
    title: "Agents",
    commands: [
      ["connect [agent]", "Connect agents to CodeAtlas"],
      ["disconnect [agent]", "Disconnect agents from CodeAtlas"],
      ["integrations", "List agent integrations"],
      ["integration", "Install or inspect agent integrations"],
    ],
  },
  {
    title: "Runtime",
    commands: [
      ["mcp", "Start the MCP server"],
      ["serve [path]", "Start the HTTP server"],
    ],
  },
  {
    title: "Other",
    commands: [["hook", "Install, remove, or inspect Git hooks"]],
  },
];

const details: Record<string, string[]> = {
  init: [
    "Usage: code-atlas init [path] [options]",
    "",
    "Initialize a repository, build its indexes, and install local guidance.",
    "",
    "Options:",
    "  --agent <id|all>   Connect an agent after initialization",
    "  --strict           Require strict integration configuration",
    "  --no-guidance      Do not write AGENTS.md guidance",
    "  --no-index         Initialize without indexing",
    "  --json             Print machine-readable output",
  ],
  index: [
    "Usage: code-atlas index [path] [options]",
    "",
    "Build graph and lexical indexes for a repository.",
    "",
    "Options:",
    "  --skip-git         Use filesystem scanning instead of Git change detection",
    "  --json             Print machine-readable output",
    "",
    "Example: code-atlas index .",
  ],
  sync: [
    "Usage: code-atlas sync [path] [options]",
    "",
    "Update graph and lexical indexes incrementally.",
    "",
    "Options:",
    "  --skip-git         Use filesystem scanning instead of Git change detection",
    "  --quiet            Suppress human progress and summary output",
    "  --json             Print machine-readable output",
  ],
  status: [
    "Usage: code-atlas status [path] [options]",
    "",
    "Show repository status and index capability states.",
    "",
    "Options:",
    "  --json             Print machine-readable output",
  ],
  "context-read": [
    "Usage: code-atlas context-read [path] --file <relative-path> --session <id> --context-generation <id> [options]",
    "",
    "Read one file with opt-in context-aware delivery.",
    "",
    "Options:",
    "  --file <path>              Repository-relative file path",
    "  --session <id>             Explicit context session id",
    "  --context-generation <id>  Explicit context generation",
    "  --json                     Print machine-readable output",
  ],
  "inspect-change": [
    "Usage: code-atlas inspect-change [path] [options]",
    "",
    "Inspect changed and affected symbols.",
    "",
    "Options:",
    "  --staged            Inspect staged changes",
    "  --commit <ref>      Inspect one commit",
    "  --base <ref> --head <ref>  Inspect a revision range",
    "  --max-depth <n>     Limit impact traversal from 0 to 10",
    "  --json              Print machine-readable output",
  ],
  "affected-tests": [
    "Usage: code-atlas affected-tests [path] [options]",
    "",
    "Find indexed tests affected by a change.",
    "",
    "Options:",
    "  --staged            Inspect staged changes",
    "  --commit <ref>      Inspect one commit",
    "  --base <ref> --head <ref>  Inspect a revision range",
    "  --max-depth <n>     Limit impact traversal from 0 to 10",
    "  --max-tests <n>      Limit returned tests",
    "  --json              Print machine-readable output",
  ],
  "explain-incomplete": [
    "Usage: code-atlas explain-incomplete [path] [options]",
    "",
    "Explain why graph or test evidence may be incomplete.",
    "",
    "Options:",
    "  --change            Explain change evidence",
    "  --tests             Explain test evidence",
    "  --staged            Inspect staged changes",
    "  --commit <ref>      Inspect one commit",
    "  --base <ref> --head <ref>  Inspect a revision range",
    "  --max-depth <n>     Limit traversal from 0 to 10",
    "  --json              Print machine-readable output",
  ],
  "graph-delta": [
    "Usage: code-atlas graph-delta [path] [options]",
    "",
    "Show structural graph changes.",
    "",
    "Options:",
    "  --staged            Inspect staged changes",
    "  --commit <ref>      Inspect one commit",
    "  --base <ref> --head <ref>  Inspect a revision range",
    "  --max-edges <n>     Limit returned edges",
    "  --json              Print machine-readable output",
  ],
  "architecture-drift": [
    "Usage: code-atlas architecture-drift [path] [options]",
    "",
    "Check changed structure against architecture rules.",
    "",
    "Options:",
    "  --staged            Inspect staged changes",
    "  --commit <ref>      Inspect one commit",
    "  --base <ref> --head <ref>  Inspect a revision range",
    "  --max-edges <n>     Limit returned edges",
    "  --config <path>     Load an architecture policy",
    "  --json              Print machine-readable output",
  ],
  gate: [
    "Usage: code-atlas gate [path] [options]",
    "",
    "Evaluate change-quality gates.",
    "",
    "Options:",
    "  --staged            Inspect staged changes",
    "  --commit <ref>      Inspect one commit",
    "  --base <ref> --head <ref>  Inspect a revision range",
    "  --max-depth <n>     Limit impact traversal",
    "  --max-tests <n>      Limit affected tests",
    "  --max-edges <n>     Limit graph edges",
    "  --json              Print machine-readable output",
  ],
  integration: [
    "Usage: code-atlas integration <action> [id] [options]",
    "",
    "List, inspect, install, or uninstall agent integrations.",
    "",
    "Actions:",
    "  list|status             Show integration status",
    "  install <id>            Install an integration",
    "  uninstall <id>          Remove an integration",
    "  config --format json    Export integration configuration",
    "",
    "Options:",
    "  --scope user|project    Choose configuration scope",
    "  --strict                Require strict configuration",
    "  --no-guidance           Do not update AGENTS.md guidance",
    "  --json                  Print machine-readable output",
  ],
  connect: [
    "Usage: code-atlas connect [agent] [options]",
    "",
    "Connect one or more agents to CodeAtlas.",
    "",
    "Options:",
    "  --all                   Connect all eligible agents",
    "  --scope user|project    Choose configuration scope",
    "  --strict                Require strict configuration",
    "  --no-guidance           Do not update AGENTS.md guidance",
    "  --json                  Print machine-readable output",
  ],
  disconnect: [
    "Usage: code-atlas disconnect [agent] [options]",
    "",
    "Disconnect one or more agents from CodeAtlas.",
    "",
    "Options:",
    "  --all                   Disconnect all managed agents",
    "  --scope user|project    Choose configuration scope",
    "  --strict                Require strict configuration",
    "  --no-guidance           Do not update AGENTS.md guidance",
    "  --json                  Print machine-readable output",
  ],
  integrations: [
    "Usage: code-atlas integrations [options]",
    "",
    "List agent integrations and their connection states.",
    "",
    "Options:",
    "  --scope user|project    Choose configuration scope",
    "  --strict                Require strict configuration",
    "  --no-guidance           Do not update AGENTS.md guidance",
    "  --json                  Print machine-readable output",
  ],
  hook: [
    "Usage: code-atlas hook install|uninstall|status [options]",
    "",
    "Manage CodeAtlas Git hooks.",
    "",
    "Options:",
    "  --post-commit           Select the post-commit hook",
    "  --post-checkout         Select the post-checkout hook",
    "  --json                  Print machine-readable output",
  ],
  mcp: [
    "Usage: code-atlas mcp",
    "",
    "Start the CodeAtlas MCP server over stdio.",
  ],
  serve: [
    "Usage: code-atlas serve [path]",
    "",
    "Start the CodeAtlas HTTP server.",
  ],
};

export function isKnownCommand(command: string): boolean {
  return Object.prototype.hasOwnProperty.call(details, command);
}

export function formatRootHelp(): string {
  const lines = ["Usage: code-atlas <command>", "", "Commands:"];
  for (const group of groups) {
    lines.push(`\n${group.title}`);
    for (const [command, description] of group.commands) lines.push(`  ${command.padEnd(28)} ${description}`);
  }
  lines.push(
    "",
    "Examples:",
    "  code-atlas init .",
    "  code-atlas integration config --format json",
    "",
    "Run `code-atlas <command> --help` for detailed options and examples.",
  );
  return lines.join("\n");
}

export function formatCommandHelp(command: string): string {
  const help = Object.prototype.hasOwnProperty.call(details, command)
    ? details[command]!
    : ["Usage: code-atlas <command>", "", "Run `code-atlas --help` to list commands."];
  return help.join("\n");
}
