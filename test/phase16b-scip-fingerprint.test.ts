import assert from "node:assert/strict";
import test from "node:test";

import { computeScipFingerprint } from "../src/core/indexing/scip-fingerprint.js";

const base = {
  repositoryId: "repo-id",
  sourceHashes: new Map([
    ["src/main.ts", "main-hash"],
    ["src/z.jsx", "z-hash"],
    ["src/a.tsx", "a-hash"],
    ["src/ignored.py", "ignored-hash"],
  ]),
  configHashes: new Map([["tsconfig.json", "config-hash"]]),
  lockfileHashes: new Map([["pnpm-lock.yaml", "lock-hash"]]),
  toolVersion: "0.4.0",
  scipSchemaVersion: "@scip-code/scip@0.10.0",
  scipProtocolVersion: 0,
  scipResolutionVersion: "scip-resolution-1",
  resolutionVersion: "resolution-1",
};

test("SCIP fingerprint is deterministic and includes repository, TS/JS inputs, config, tool, and versions", () => {
  const fingerprint = computeScipFingerprint(base);
  assert.equal(fingerprint, computeScipFingerprint({
    ...base,
    sourceHashes: new Map([...base.sourceHashes].reverse()),
    configHashes: new Map([...base.configHashes].reverse()),
    lockfileHashes: new Map([...base.lockfileHashes].reverse()),
  }));

  for (const changed of [
    { ...base, repositoryId: "another-repo" },
    { ...base, sourceHashes: new Map([...base.sourceHashes, ["src/a.tsx", "changed"]]) },
    { ...base, sourceHashes: new Map([...base.sourceHashes, ["src/z.jsx", "changed"]]) },
    { ...base, configHashes: new Map([["tsconfig.json", "changed"]]) },
    { ...base, lockfileHashes: new Map([["pnpm-lock.yaml", "changed"]]) },
    { ...base, toolVersion: "0.5.0" },
    { ...base, scipSchemaVersion: "@scip-code/scip@0.11.0" },
    { ...base, scipProtocolVersion: 1 },
    { ...base, scipResolutionVersion: "scip-resolution-2" },
    { ...base, resolutionVersion: "resolution-2" },
  ]) {
    assert.notEqual(computeScipFingerprint(changed), fingerprint);
  }
});
