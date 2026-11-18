import assert from "node:assert/strict";
import test from "node:test";

import { FRAMEWORK_RESOLUTION_VERSION } from "../src/core/repository/index-version.js";
import { isCertifiedPackageFrameworkVersion } from "../src/storage/atlas/workspace-package.reader.js";

test("workspace package reader explicitly certifies current 1.7.1 and historical 1.7.0 evidence domains", () => {
  assert.equal(FRAMEWORK_RESOLUTION_VERSION, "1.7.1");
  assert.equal(isCertifiedPackageFrameworkVersion("1.7.0"), true);
  assert.equal(isCertifiedPackageFrameworkVersion(FRAMEWORK_RESOLUTION_VERSION), true);
});

test("workspace package reader fails closed on unreviewed framework versions", () => {
  for (const unsupported of ["", "1.6.9", "1.7.2", "1.8.0", "2.0.0", "1.7.1-beta"]) {
    assert.equal(isCertifiedPackageFrameworkVersion(unsupported), false, unsupported);
  }
});
