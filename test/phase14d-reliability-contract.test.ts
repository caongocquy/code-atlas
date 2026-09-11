import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalReliabilityScope,
  reliabilityOutputKey,
  reliabilityScopeKey,
  reliabilityOwnerKey,
} from "../src/core/reliability/reliability-identity.js";
import {
  normalizeEvidenceRefs,
  fromFrameworkEvidenceRef,
  fromParsedFactRef,
  fromResolutionEvidence,
} from "../src/core/reliability/reliability-normalize.js";

test("normalizes evidence refs and scopes deterministically", () => {
  const refs = normalizeEvidenceRefs([
    {
      origin: "framework_inferred",
      sourcePath: "src/routes.ts",
      inputKey: "route",
      ownerKey: "owner-b",
    },
    {
      origin: "extracted",
      sourcePath: "src/routes.ts",
      inputKey: "route",
      ownerKey: "owner-a",
    },
  ]);

  assert.deepEqual(refs.map((ref) => ref.origin), ["extracted", "framework_inferred"]);

  const first = canonicalReliabilityScope({
    capability: "route_binding",
    framework: "next",
    selectorKey: "users",
  });
  const second = canonicalReliabilityScope({
    selectorKey: "users",
    framework: "next",
    capability: "route_binding",
  });
  assert.equal(reliabilityScopeKey(first), reliabilityScopeKey(second));
});

test("semantic keys exclude generation and checkout identity", () => {
  const first = reliabilityOutputKey({
    kind: "classification",
    subject: { kind: "language", nodeId: "module:src/a.ts" },
    classificationKind: "execution_boundary",
  });
  const second = reliabilityOutputKey({
    kind: "classification",
    subject: { kind: "language", nodeId: "module:src/a.ts" },
    classificationKind: "execution_boundary",
  });

  assert.equal(first, second);
  assert.doesNotMatch(first, /worktrees|generation|timestamp/i);
  assert.equal(
    reliabilityOwnerKey({ sourcePath: "src/a.ts", inputKey: "facts", capability: "imports" }),
    reliabilityOwnerKey({ sourcePath: "src/a.ts", inputKey: "facts", capability: "imports" }),
  );
});

test("rejects absolute and traversal filesystem paths", () => {
  assert.equal(canonicalReliabilityScope({ capability: "x", selectorKey: "/route/users" }).selectorKey, "/route/users");
  assert.throws(() => reliabilityOwnerKey({ sourcePath: "../src/a.ts", inputKey: "facts" }), /canonical|relative/i);
  assert.throws(() => reliabilityOwnerKey({ sourcePath: "/tmp/repo/src/a.ts", inputKey: "facts" }), /canonical|relative/i);
});

test("maps existing evidence shapes to explicit reliability origins", () => {
  const frameworkRef = fromFrameworkEvidenceRef({
    relativePath: "src/routes.ts",
    inputKey: "route:/users",
    localId: "route-1",
  }, "owner-framework");
  const extractedRef = fromParsedFactRef("src/routes.ts", "facts:imports", {
    startLine: 2,
    endLine: 2,
  }, "owner-facts");
  const inferredRef = fromResolutionEvidence({
    evidenceKind: "INFERRED",
    resolutionMethod: "import_binding",
    source: { file: "src/routes.ts", line: 4 },
  }, "owner-resolution");

  assert.equal(frameworkRef.origin, "framework_inferred");
  assert.equal(extractedRef.origin, "extracted");
  assert.equal(inferredRef.origin, "language_inferred");
  assert.equal(frameworkRef.sourcePath, extractedRef.sourcePath);
  assert.equal(inferredRef.range?.startLine, 4);
});
