import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("integration CLI aliases delegate to canonical service operations", async () => {
  const source = await readFile(new URL("../src/adapters/cli/integration.command.ts", import.meta.url), "utf8");

  assert.match(source, /service\.connect/);
  assert.match(source, /service\.disconnect/);
  assert.doesNotMatch(source, /service\.install|service\.uninstall/);
});

test("init integration handling delegates to canonical connect", async () => {
  const source = await readFile(new URL("../src/adapters/cli/init.command.ts", import.meta.url), "utf8");

  assert.match(source, /service\.connect/);
  assert.match(source, /agent === "all" \? service\.listDescriptors\(\)/);
  assert.doesNotMatch(source, /supportedAgentIds/);
  assert.doesNotMatch(source, /service\.install|service\.uninstall/);
});
