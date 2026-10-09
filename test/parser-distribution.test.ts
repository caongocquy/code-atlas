import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { artifactFiles, unpack } from '../scripts/parser-distribution.mjs';

const script = fileURLToPath(new URL('../scripts/parser-distribution.mjs', import.meta.url));
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];
const sources = JSON.parse(String(readFileSync(new URL('../scripts/parser-sources.json', import.meta.url))));
const nativeHost = `${process.platform}-${process.arch}`;

test('unpack passes tar a relative archive name and extraction destination', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'parser-tar-path-'));
  try {
    const archiveDirectory = path.join(root, 'archives');
    const extractionDirectory = path.join(root, 'extract', 'package');
    mkdirSync(archiveDirectory);
    const archive = path.join(archiveDirectory, 'grammar.tgz');
    writeFileSync(archive, 'fixture');
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const execute = (command: string, args: string[], options: { cwd: string }) => {
      calls.push({ command, args, cwd: options.cwd });
      if (args[0] === '-tzf') return 'package/\npackage/package.json\n';
      const destination = args[args.indexOf('-C') + 1];
      mkdirSync(path.join(options.cwd, destination, 'package'), { recursive: true });
      writeFileSync(path.join(options.cwd, destination, 'package', 'package.json'), '{}');
      return '';
    };

    await unpack(archive, path.dirname(extractionDirectory), execute);

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.command, 'tar');
      assert.equal(call.cwd, archiveDirectory);
      assert.equal(call.args[1], path.basename(archive));
      assert.ok(call.args.every((argument) => !path.isAbsolute(argument)));
    }
    const extractionPath = calls[1].args[calls[1].args.indexOf('-C') + 1];
    assert.ok(extractionPath);
    assert.ok(!extractionPath.includes('\\'));
    assert.equal(await readFileSync(path.join(extractionDirectory, 'package.json'), 'utf8'), '{}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function binary(platform: string) {
  const data = Buffer.alloc(128);
  if (platform.startsWith('linux-')) {
    data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    data.writeUInt16LE(62, 18);
  } else if (platform.startsWith('win32-')) {
    data.set([0x4d, 0x5a], 0);
    data.writeUInt32LE(64, 0x3c);
    data.set([0x50, 0x45, 0, 0], 64);
    data.writeUInt16LE(0x8664, 68);
  } else {
    data.writeUInt32LE(0xfeedfacf, 0);
    data.writeUInt32LE(platform.endsWith('arm64') ? 0x0100000c : 0x01000007, 4);
  }
  return data;
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'parser-distribution-'));
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  copyFileSync(script, path.join(root, 'scripts/parser-distribution.mjs'));
  copyFileSync(new URL('../scripts/parser-sources.json', import.meta.url), path.join(root, 'scripts/parser-sources.json'));
  const packages = [sources.runtime, ...sources.grammars].map(({ name, version, integrity }) => {
    const destination = path.join(root, 'vendor/parsers', name);
    mkdirSync(destination, { recursive: true });
    const license = name === '@driftlog/tree-sitter-dart' ? 'ISC' : 'MIT';
    const provenance = JSON.stringify({ name, version, license });
    writeFileSync(path.join(destination, 'package.json'), provenance);
    writeFileSync(path.join(destination, 'LICENSE'), `License: ${license}\n`);
    const files = { 'package.json': sha256(provenance), LICENSE: sha256(`License: ${license}\n`) };
    const prebuilds: Record<string, Array<{ file: string; sha256: string }>> = {};
    for (const platform of platforms) {
      const filename = `prebuilds/${platform}/parser.node`;
      const bytes = binary(platform);
      mkdirSync(path.dirname(path.join(destination, filename)), { recursive: true });
      writeFileSync(path.join(destination, filename), bytes);
      files[filename] = sha256(bytes);
      prebuilds[platform] = [{ file: filename, sha256: sha256(bytes) }];
    }
    return { name, version, integrity, sourceSha256: 'a'.repeat(64), sourceManifest: { name, version, license }, files, licenseFiles: { LICENSE: files.LICENSE }, prebuilds };
  });
  writeFileSync(path.join(root, 'vendor/parsers/parser-distribution.json'), JSON.stringify({ schemaVersion: 1, runtime: 'tree-sitter@0.25.1', packages }, null, 2));
  assert.ok(packages.every((pkg) => pkg.prebuilds[nativeHost]?.length));
  return root;
}

function prebuildFixture(root: string) {
  const native = sources.grammars.filter(({ name }: { name: string }) => ['tree-sitter-kotlin', '@driftlog/tree-sitter-dart'].includes(name));
  for (const target of platforms) {
    const directory = path.join(root, '.parser-build', target);
    mkdirSync(directory, { recursive: true });
    const packages: Record<string, unknown> = {};
    for (const source of native) {
      const file = source.name === 'tree-sitter-kotlin' ? 'tree-sitter-kotlin.node' : 'tree-sitter-dart.node';
      const bytes = binary(target);
      writeFileSync(path.join(directory, file), bytes);
      packages[file] = {
        name: source.name,
        version: target === 'darwin-arm64' && source.name === 'tree-sitter-kotlin' ? '0.0.0' : source.version,
        integrity: source.integrity,
        sourceSha256: 'b'.repeat(64),
        sha256: sha256(bytes),
      };
    }
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      platform: target.split('-')[0],
      arch: target.split('-')[1],
      nodeVersion: 'v22.23.3',
      napiVersion: 8,
      nodeAddonApiVersion: '7.1.1',
      packages,
    }));
  }
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/parser-distribution.mjs'), ...args], { cwd: root, encoding: 'utf8' });
}

test('verify rejects a prebuild whose bytes no longer match its recorded checksum', () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, 'vendor/parsers/tree-sitter-kotlin/prebuilds/linux-x64/parser.node'), 'corrupt');
    const result = run(root, 'verify', '--all-targets');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum|hash|inventory/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify rejects a binary whose machine architecture disagrees with its target directory', () => {
  const root = fixture();
  try {
    const bytes = binary('linux-x64');
    bytes.writeUInt16LE(183, 18);
    const file = path.join(root, 'vendor/parsers/tree-sitter-kotlin/prebuilds/linux-x64/parser.node');
    writeFileSync(file, bytes);
    const manifest = JSON.parse(String(readFileSync(path.join(root, 'vendor/parsers/parser-distribution.json'))));
    const kotlin = manifest.packages.find((pkg: { name: string }) => pkg.name === 'tree-sitter-kotlin');
    kotlin.files['prebuilds/linux-x64/parser.node'] = sha256(bytes);
    kotlin.prebuilds['linux-x64'][0].sha256 = sha256(bytes);
    writeFileSync(path.join(root, 'vendor/parsers/parser-distribution.json'), JSON.stringify(manifest));
    const result = run(root, 'verify');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /architecture|machine|target/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify --all-targets fails closed when one required grammar binary is missing', () => {
  const root = fixture();
  try {
    const manifestPath = path.join(root, 'vendor/parsers/parser-distribution.json');
    const manifest = JSON.parse(String(readFileSync(manifestPath)));
    const dart = manifest.packages.find((pkg: { name: string }) => pkg.name === '@driftlog/tree-sitter-dart');
    delete dart.files['prebuilds/win32-x64/parser.node'];
    delete dart.prebuilds['win32-x64'];
    rmSync(path.join(root, 'vendor/parsers/@driftlog/tree-sitter-dart/prebuilds/win32-x64/parser.node'));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = run(root, 'verify', '--all-targets');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing|required|win32-x64/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify checks only host coverage when --all-targets is omitted', () => {
  const root = fixture();
  try {
    const absent = platforms.find((target) => target !== nativeHost);
    assert.ok(absent);
    rmSync(path.join(root, 'vendor/parsers/tree-sitter-kotlin/prebuilds', absent, 'parser.node'));
    const manifestPath = path.join(root, 'vendor/parsers/parser-distribution.json');
    const manifest = JSON.parse(String(readFileSync(manifestPath)));
    const kotlin = manifest.packages.find((pkg: { name: string }) => pkg.name === 'tree-sitter-kotlin');
    delete kotlin.files[`prebuilds/${absent}/parser.node`];
    delete kotlin.prebuilds[absent];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const all = run(root, 'verify', '--all-targets');
    const host = run(root, 'verify');
    assert.notEqual(all.status, 0);
    assert.equal(host.status, 0, host.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify rejects a package after its license asset and checksums are removed', () => {
  const root = fixture();
  try {
    const manifestPath = path.join(root, 'vendor/parsers/parser-distribution.json');
    const manifest = JSON.parse(String(readFileSync(manifestPath)));
    const kotlin = manifest.packages.find((pkg: { name: string }) => pkg.name === 'tree-sitter-kotlin');
    delete kotlin.files.LICENSE;
    delete kotlin.licenseFiles.LICENSE;
    rmSync(path.join(root, 'vendor/parsers/tree-sitter-kotlin/LICENSE'));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = run(root, 'verify');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /license/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepare rejects native artifacts built from a different pinned grammar version', () => {
  const root = fixture();
  try {
    prebuildFixture(root);
    const result = run(root, 'prepare', '--prebuild-input', '.parser-build');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source provenance mismatch/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifactFiles accepts exactly the valid Kotlin and Dart binaries for a target', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'parser-artifact-input-'));
  try {
    prebuildFixture(root);
    const artifacts = await artifactFiles(path.join(root, '.parser-build'), 'linux-x64');
    assert.deepEqual(Object.keys(artifacts).sort(), ['tree-sitter-dart.node', 'tree-sitter-kotlin.node']);
    assert.deepEqual(Object.keys(artifacts['tree-sitter-kotlin.node']), ['bytes', 'sourceSha256']);
    assert.equal(artifacts['tree-sitter-kotlin.node'].sourceSha256, 'b'.repeat(64));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
