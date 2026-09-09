import assert from "node:assert/strict";
import test from "node:test";

import { runPackedMcpInitialize } from "./helpers/phase14b-conformance.js";

test("packed CLI initializes MCP over stdio", async () => {
  assert.ok(process.env.PACKED_CLI_PATH, "PACKED_CLI_PATH must point to a packed CLI");
  const response = await runPackedMcpInitialize(process.env.PACKED_CLI_PATH);
  assert.equal(typeof response.protocolVersion, "string");
  assert.equal(response.serverName, "code-atlas");
});

test("packed MCP helper rejects a child that cannot initialize", async () => {
  await assert.rejects(() => runPackedMcpInitialize(process.execPath), /MCP|process|JSON|initialize/i);
});
