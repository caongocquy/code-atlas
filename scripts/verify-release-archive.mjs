import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Compare extracted contents, including links and executable bits, on the native build host.
export function inventoryBundle(root) {
  const files = {};
  let logicalBytes = 0;
  let allocatedBytes = 0;
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) { visit(file); continue; }
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        const resolved = path.resolve(path.dirname(file), target);
        assert.ok(resolved.startsWith(path.resolve(root) + path.sep), `Link escapes bundle: ${relative}`);
        assert.ok(fs.existsSync(file), `Broken link: ${relative}`);
        files[relative] = { target };
      } else {
        assert.ok(stat.isFile(), `Unsupported artifact entry: ${relative}`);
        const hash = crypto.createHash("sha256");
        const descriptor = fs.openSync(file, "r");
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          let bytes;
          while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
        } finally { fs.closeSync(descriptor); }
        files[relative] = { bytes: stat.size, sha256: hash.digest("hex"), ...(process.platform === "win32" ? {} : { executable: stat.mode & 0o111 }) };
        logicalBytes += stat.size;
        if (typeof stat.blocks === "number") allocatedBytes += stat.blocks * 512;
      }
    }
  };
  visit(path.resolve(root));
  return { files, logicalBytes, allocatedBytes: process.platform === "win32" ? null : allocatedBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, root, manifest] = process.argv.slice(2);
  assert.ok(["snapshot", "verify"].includes(mode) && root && manifest, "Usage: verify-release-archive.mjs snapshot|verify <bundle> <manifest>");
  const inventory = inventoryBundle(root);
  if (mode === "snapshot") fs.writeFileSync(manifest, JSON.stringify(inventory, null, 2) + "\n");
  else assert.deepEqual(inventory.files, JSON.parse(fs.readFileSync(manifest, "utf8")).files, "Archive extraction changed artifact content");
  process.stdout.write(JSON.stringify({ mode, entries: Object.keys(inventory.files).length, logicalBytes: inventory.logicalBytes, allocatedBytes: inventory.allocatedBytes }) + "\n");
}
