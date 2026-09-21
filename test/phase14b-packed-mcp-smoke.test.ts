import assert from "node:assert/strict";
import test from "node:test";

import { runPackedMcpInitialize } from "./helpers/phase14b-conformance.js";

const packedCliPath = process.env.PACKED_CLI_PATH;

test("packed CLI initializes MCP over stdio", { skip: packedCliPath ? false : "PACKED_CLI_PATH is unset; run the mandatory Step 6 packed MCP check with a packed CLI path" }, async () => {
  const response = await runPackedMcpInitialize(packedCliPath!);
  assert.equal(typeof response.protocolVersion, "string");
  assert.equal(response.serverName, "code-atlas");
});

test("packed MCP helper rejects a child that cannot initialize", async () => {
  await assert.rejects(() => runPackedMcpInitialize(process.execPath), /MCP|process|JSON|initialize/i);
});
