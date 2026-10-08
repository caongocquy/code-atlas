import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inventoryBundle } from "../scripts/verify-release-archive.mjs";

test("archive inventory detects changed bytes, executable bits, and escaping links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-integrity-"));
  try {
    const binary = path.join(root, "node");
    fs.writeFileSync(binary, "runtime", { mode: 0o755 });
    const original = inventoryBundle(root);
    fs.writeFileSync(binary, "corrupt");
    assert.notDeepEqual(inventoryBundle(root).files, original.files);
    fs.writeFileSync(binary, "runtime");
    if (process.platform !== "win32") {
      fs.chmodSync(binary, 0o644);
      assert.notDeepEqual(inventoryBundle(root).files, original.files);
      fs.symlinkSync("../outside", path.join(root, "escape"));
      assert.throws(() => inventoryBundle(root), /escapes bundle/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
