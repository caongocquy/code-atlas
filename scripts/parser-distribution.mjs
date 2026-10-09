#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createWriteStream, existsSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'parsers');
const SOURCES = JSON.parse(await readFile(new URL('./parser-sources.json', import.meta.url), 'utf8'));
const REQUIRED_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];
const NATIVE_PACKAGES = ['tree-sitter-kotlin', '@driftlog/tree-sitter-dart'];
const NODE_GYP_VERSION = '12.3.0';
const NODE_ADDON_API_VERSION = '7.1.1';
const NODE_HEADERS_VERSION = 'v22.23.3';
const NAPI_VERSION = 8;

function fail(message) {
  throw new Error(message);
}

function digest(data, algorithm = 'sha256') {
  return createHash(algorithm).update(data).digest('hex');
}

function slug(name) {
  return name.replaceAll('/', '+');
}

function packageList() {
  return [SOURCES.runtime, ...SOURCES.grammars];
}

function targetTuple(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function parseTuple(value) {
  const match = /^(darwin|linux|win32)-(arm64|x64)$/.exec(value);
  if (!match) fail(`Unsupported platform/architecture tuple: ${value}`);
  return { platform: match[1], arch: match[2] };
}

function safeRelative(value) {
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) fail(`Unsafe archive path: ${value}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function download(pkg, destination) {
  const fileName = `${pkg.name.split('/').at(-1)}-${pkg.version}.tgz`;
  const url = `https://registry.npmjs.org/${pkg.name}/-/${fileName}`;
  let response;
  try {
    response = await globalThis.fetch(url, { redirect: 'error' });
  } catch (error) {
    fail(`Registry download failed for ${pkg.name}@${pkg.version}: ${error.message}`);
  }
  if (!response.ok || !response.body) fail(`Could not download ${pkg.name}@${pkg.version}: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(destination, { flags: 'wx' }));
  const bytes = await readFile(destination);
  const [algorithm, expected] = pkg.integrity.split('-', 2);
  const actual = createHash(algorithm).update(bytes).digest('base64');
  if (actual !== expected) fail(`Integrity mismatch for ${pkg.name}@${pkg.version}`);
  return { bytes, sourceSha256: digest(bytes) };
}

async function unpack(archive, destination, execute = run) {
  const workingDirectory = path.dirname(path.resolve(archive));
  const archiveName = path.basename(archive);
  const extractionDirectory = path.relative(workingDirectory, path.resolve(destination)).split(path.sep).join('/') || '.';
  if (path.isAbsolute(extractionDirectory)) fail(`Archive and extraction directory must share a volume: ${archive}`);
  const listing = execute('tar', ['-tzf', archiveName], { cwd: workingDirectory });
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (!entries.length) fail(`Empty package archive: ${archive}`);
  for (const entry of entries) {
    safeRelative(entry);
    if (!entry.startsWith('package/') && entry !== 'package') fail(`Unexpected archive root: ${entry}`);
  }
  await mkdir(destination, { recursive: true });
  execute('tar', ['-xzf', archiveName, '-C', extractionDirectory, '--no-same-owner', '--no-same-permissions'], { cwd: workingDirectory });
  const extracted = path.join(destination, 'package');
  for (const entry of await readdir(extracted, { recursive: true })) {
    const fullPath = path.join(extracted, entry);
    if ((await lstat(fullPath)).isSymbolicLink()) fail(`Package archives may not contain symlinks: ${entry}`);
  }
  return extracted;
}

function machineFor(bytes, target) {
  const tuple = parseTuple(target);
  const expectedFormat = { darwin: 'Mach-O', linux: 'ELF', win32: 'PE' }[tuple.platform];
  let format;
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (tuple.platform !== 'linux') fail(`${target} requires ${expectedFormat}, found ELF`);
    if (bytes[4] !== 2 || ![1, 2].includes(bytes[5])) fail(`${target} ELF must be a valid 64-bit binary`);
    if (bytes.length < 20) fail(`${target} ELF header is truncated`);
    const little = bytes[5] === 1;
    const machine = little ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
    const expected = tuple.arch === 'x64' ? 62 : 183;
    if (machine !== expected) fail(`${target} ELF has machine ${machine}, expected ${expected}`);
    format = 'ELF';
  } else if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    if (tuple.platform !== 'win32') fail(`${target} requires ${expectedFormat}, found PE`);
    if (bytes.length < 64) fail(`${target} PE DOS header is truncated`);
    const offset = bytes.readUInt32LE(0x3c);
    if (offset + 6 > bytes.length) fail(`${target} PE header is truncated`);
    if (bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') fail(`${target} file has an invalid PE header`);
    const machine = bytes.readUInt16LE(offset + 4);
    const expected = tuple.arch === 'x64' ? 0x8664 : 0xaa64;
    if (machine !== expected) fail(`${target} PE has machine 0x${machine.toString(16)}, expected 0x${expected.toString(16)}`);
    format = 'PE';
  } else {
    if (tuple.platform !== 'darwin') fail(`${target} requires ${expectedFormat}, found an unrecognized native format`);
    if (bytes.length < 8) fail(`${target} Mach-O header is truncated`);
    const magic = bytes.readUInt32LE(0);
    const fatMagic = bytes.readUInt32BE(0);
    const expected = tuple.arch === 'x64' ? 0x01000007 : 0x0100000c;
    if (fatMagic === 0xcafebabe || fatMagic === 0xcafebabf) {
      const is64 = fatMagic === 0xcafebabf;
      const count = bytes.readUInt32BE(4);
      const stride = is64 ? 32 : 20;
      if (count > Math.floor((bytes.length - 8) / stride)) fail(`${target} Mach-O universal header is truncated`);
      for (let index = 0; index < count; index++) {
        if (bytes.readUInt32BE(8 + index * stride) === expected) {
          format = 'Mach-O';
          break;
        }
      }
      if (!format) fail(`${target} Mach-O universal binary lacks the target architecture`);
    } else if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) {
      const little = magic === 0xfeedface || magic === 0xfeedfacf;
      const machine = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
      if (machine !== expected) fail(`${target} Mach-O has CPU 0x${machine.toString(16)}, expected 0x${expected.toString(16)}`);
      format = 'Mach-O';
    } else {
      fail(`${target} native asset is not a recognized ELF, Mach-O, or PE binary`);
    }
  }
  return format;
}

async function materializePackage(pkg, stageRoot, build = false) {
  const archive = path.join(stageRoot, `${slug(pkg.name)}-${pkg.version}.tgz`);
  const { sourceSha256 } = await download(pkg, archive);
  const originalRoot = await unpack(archive, path.join(stageRoot, 'extract', slug(pkg.name)));
  const originalManifest = JSON.parse(await readFile(path.join(originalRoot, 'package.json'), 'utf8'));
  if (originalManifest.name !== pkg.name || originalManifest.version !== pkg.version) fail(`Archive metadata mismatch for ${pkg.name}`);
  const destination = path.join(VENDOR, pkg.name);
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(originalRoot, destination, { recursive: true, dereference: true });
  await removeInvalidOptionalPrebuilds(pkg.name, destination);

  const runtimeManifest = {
    name: pkg.name,
    version: pkg.version,
    ...(originalManifest.description ? { description: originalManifest.description } : {}),
    ...(originalManifest.license ? { license: originalManifest.license } : {}),
    ...(originalManifest.main ? { main: originalManifest.main } : {}),
    ...(originalManifest.types ? { types: originalManifest.types } : {}),
    ...(originalManifest.typings ? { typings: originalManifest.typings } : {}),
    ...(originalManifest.exports ? { exports: originalManifest.exports } : {}),
  };
  await writeFile(path.join(destination, 'package.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`);
  const record = {
    name: pkg.name,
    version: pkg.version,
    integrity: pkg.integrity,
    sourceSha256,
    sourceManifest: originalManifest,
    files: {},
    prebuilds: {},
  };
  if (build) {
    const bytes = await compileNative(pkg, originalRoot, sourceSha256);
    const prebuildPath = path.join(destination, 'prebuilds', targetTuple(), 'napi.node');
    await mkdir(path.dirname(prebuildPath), { recursive: true });
    await writeFile(prebuildPath, bytes);
  }
  await collectPackageFiles(destination, record);
  await mkdir(VENDOR, { recursive: true });
  return record;
}

async function removeInvalidOptionalPrebuilds(packageName, directory) {
  const prebuildRoot = path.join(directory, 'prebuilds');
  if (!existsSync(prebuildRoot)) return;
  for (const target of await readdir(prebuildRoot, { withFileTypes: true })) {
    if (!target.isDirectory()) continue;
    const tuple = target.name;
    const targetDirectory = path.join(prebuildRoot, tuple);
    for (const file of await readdir(targetDirectory)) {
      if (!file.endsWith('.node')) continue;
      const absolute = path.join(targetDirectory, file);
      const bytes = await readFile(absolute);
      try {
        machineFor(bytes, tuple);
      } catch (error) {
        if (REQUIRED_TARGETS.includes(tuple)) fail(`${packageName}/${tuple}/${file}: ${error.message}`);
        await rm(absolute);
        process.stderr.write(`Removed invalid upstream prebuild ${packageName}/${tuple}/${file}: ${error.message}\n`);
      }
    }
  }
}

async function collectPackageFiles(destination, record) {
  record.files = {};
  record.prebuilds = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(destination, absolute).split(path.sep).join('/');
        const bytes = await readFile(absolute);
        record.files[relative] = digest(bytes);
        const match = /^prebuilds\/(darwin|linux|win32)-(arm64|x64)\/(.+\.node)$/.exec(relative);
        if (match) {
          const target = `${match[1]}-${match[2]}`;
          const format = machineFor(bytes, target);
          record.prebuilds[target] ??= [];
          record.prebuilds[target].push({ file: relative, sha256: digest(bytes), format });
        }
      } else fail(`Unsupported package asset type: ${absolute}`);
    }
  }
  await visit(destination);
  record.licenseFiles = Object.fromEntries(Object.entries(record.files).filter(([file]) => /^(license|copying)(\.(md|txt|rst))?$/i.test(file)));
  if (!record.licenseFiles || Object.keys(record.licenseFiles).length === 0) fail(`Missing top-level license file in ${record.name}`);
  for (const entries of Object.values(record.prebuilds)) entries.sort((a, b) => a.file.localeCompare(b.file));
}

async function compileNative(pkg, sourceDirectory, sourceSha256) {
  const tuple = targetTuple();
  if (!REQUIRED_TARGETS.includes(tuple)) fail(`Native build is restricted to supported targets: ${REQUIRED_TARGETS.join(', ')}`);
  if (process.version !== NODE_HEADERS_VERSION) fail(`Native builds must use Node ${NODE_HEADERS_VERSION}; found ${process.version}`);
  const nodeGyp = path.join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  const nodeGypManifest = path.join(ROOT, 'node_modules', 'node-gyp', 'package.json');
  const addonApi = path.join(ROOT, 'node_modules', 'node-addon-api');
  if (!existsSync(nodeGyp) || !existsSync(nodeGypManifest)) fail(`Missing node-gyp@${NODE_GYP_VERSION} dev dependency. Install repository devDependencies first.`);
  const nodeGypPackage = JSON.parse(await readFile(nodeGypManifest, 'utf8'));
  if (nodeGypPackage.version !== NODE_GYP_VERSION) fail(`Expected node-gyp@${NODE_GYP_VERSION}, found ${nodeGypPackage.version}`);
  if (!existsSync(path.join(addonApi, 'package.json'))) fail(`Missing node-addon-api@${NODE_ADDON_API_VERSION} dev dependency.`);
  const addonManifest = JSON.parse(await readFile(path.join(addonApi, 'package.json'), 'utf8'));
  if (addonManifest.version !== NODE_ADDON_API_VERSION) fail(`Expected node-addon-api@${NODE_ADDON_API_VERSION}, found ${addonManifest.version}`);
  if (!existsSync(path.join(sourceDirectory, 'binding.gyp'))) fail(`Missing binding.gyp in ${pkg.name}`);
  const stagedModule = path.join(sourceDirectory, 'node_modules', 'node-addon-api');
  await mkdir(path.dirname(stagedModule), { recursive: true });
  await cp(addonApi, stagedModule, { recursive: true, dereference: true });
  const nodeRoot = path.resolve(path.dirname(process.execPath), '..');
  const args = [nodeGyp, 'rebuild', '--directory', sourceDirectory];
  if (existsSync(path.join(nodeRoot, 'include', 'node', 'node.h'))) args.push('--nodedir', nodeRoot);
  args.push('--', `-DNAPI_VERSION=${NAPI_VERSION}`);
  run(process.execPath, args, {
    cwd: sourceDirectory,
    env: { ...process.env, npm_config_nodedir: process.env.npm_config_nodedir ?? undefined },
    stdio: 'inherit',
  });
  const buildDir = path.join(sourceDirectory, 'build', 'Release');
  const binaries = (await readdir(buildDir)).filter((file) => file.endsWith('.node'));
  if (binaries.length !== 1) fail(`${pkg.name} build produced ${binaries.length} native modules; expected exactly one`);
  const binaryPath = path.join(buildDir, binaries[0]);
  const binaryBytes = await readFile(binaryPath);
  machineFor(binaryBytes, tuple);
  const artifactDirectory = path.join(ROOT, '.parser-build', tuple);
  await mkdir(artifactDirectory, { recursive: true });
  const artifactName = pkg.name === 'tree-sitter-kotlin' ? 'tree-sitter-kotlin.node' : 'tree-sitter-dart.node';
  const artifactBytes = binaryBytes;
  await writeFile(path.join(artifactDirectory, artifactName), artifactBytes);
  const manifestPath = path.join(artifactDirectory, 'manifest.json');
  const existing = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : { packages: {} };
  existing.packages[artifactName] = {
    name: pkg.name,
    version: pkg.version,
    integrity: pkg.integrity,
    sourceSha256,
    sha256: digest(artifactBytes),
  };
  const artifactManifest = {
    schemaVersion: 1,
    platform: parseTuple(tuple).platform,
    arch: parseTuple(tuple).arch,
    nodeVersion: process.version,
    napiVersion: NAPI_VERSION,
    nodeAddonApiVersion: NODE_ADDON_API_VERSION,
    packages: existing.packages,
  };
  await writeFile(path.join(artifactDirectory, 'manifest.json'), `${JSON.stringify(artifactManifest, null, 2)}\n`);
  return binaryBytes;
}

async function artifactFiles(inputDirectory, tuple) {
  const { platform, arch } = parseTuple(tuple);
  const directory = path.join(inputDirectory, tuple);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.arch !== arch) fail(`Artifact manifest target does not match ${tuple}`);
  if (manifest.nodeVersion !== NODE_HEADERS_VERSION) fail(`Artifact for ${tuple} must be built with Node ${NODE_HEADERS_VERSION} headers`);
  if (manifest.nodeAddonApiVersion !== NODE_ADDON_API_VERSION || manifest.napiVersion !== NAPI_VERSION) fail(`Artifact build settings mismatch for ${tuple}`);
  const expected = Object.fromEntries(NATIVE_PACKAGES.map((name) => {
    const source = packageList().find((pkg) => pkg.name === name);
    return [name === 'tree-sitter-kotlin' ? 'tree-sitter-kotlin.node' : 'tree-sitter-dart.node', source];
  }));
  if (Object.keys(manifest.packages).sort().join(',') !== Object.keys(expected).sort().join(',')) fail(`Artifact for ${tuple} must contain exactly Kotlin and Dart prebuilds`);
  const result = {};
  for (const [file, source] of Object.entries(expected)) {
    const metadata = manifest.packages[file];
    if (metadata.name !== source.name || metadata.version !== source.version || metadata.integrity !== source.integrity || !/^[a-f0-9]{64}$/.test(metadata.sourceSha256)) fail(`Artifact source provenance mismatch: ${tuple}/${file}`);
    const bytes = await readFile(path.join(directory, file));
    if (digest(bytes) !== metadata.sha256) fail(`Artifact checksum mismatch: ${tuple}/${file}`);
    machineFor(bytes, tuple);
    result[file] = { bytes, sourceSha256: metadata.sourceSha256 };
  }
  const actualEntries = (await readdir(directory)).sort();
  if (actualEntries.join(',') !== ['manifest.json', ...Object.keys(expected)].sort().join(',')) fail(`Unexpected files in artifact for ${tuple}`);
  return result;
}

async function prepare({ buildMissing = false, prebuildInput }) {
  const stageRoot = await mkdtemp(path.join(os.tmpdir(), 'code-atlas-parser-'));
  try {
    const tuple = targetTuple();
    if (buildMissing) await rm(path.join(ROOT, '.parser-build', tuple), { recursive: true, force: true });
    let nativeArtifacts = new Map();
    if (prebuildInput) {
      for (const target of REQUIRED_TARGETS) nativeArtifacts.set(target, await artifactFiles(path.resolve(prebuildInput), target));
    } else if (!buildMissing) {
      fail('Use prepare --build-missing or prepare --prebuild-input DIR.');
    }
    const records = [];
    for (const pkg of packageList()) {
      records.push(await materializePackage(pkg, stageRoot, buildMissing && NATIVE_PACKAGES.includes(pkg.name)));
    }
    if (prebuildInput) {
      for (const record of records.filter(({ name }) => NATIVE_PACKAGES.includes(name))) {
        const directory = path.join(VENDOR, record.name);
        const file = record.name === 'tree-sitter-kotlin' ? 'tree-sitter-kotlin.node' : 'tree-sitter-dart.node';
        for (const target of REQUIRED_TARGETS) {
          const artifact = nativeArtifacts.get(target)[file];
          if (artifact.sourceSha256 !== record.sourceSha256) fail(`Artifact source hash mismatch: ${target}/${file}`);
          const relative = `prebuilds/${target}/napi.node`;
          await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
          await writeFile(path.join(directory, relative), artifact.bytes);
        }
        await collectPackageFiles(directory, record);
      }
    }
    const distribution = {
      schemaVersion: 1,
      runtime: `${SOURCES.runtime.name}@${SOURCES.runtime.version}`,
      build: { napiVersion: NAPI_VERSION, nodeAddonApiVersion: NODE_ADDON_API_VERSION },
      requiredTargets: REQUIRED_TARGETS,
      packages: records,
    };
    await mkdir(VENDOR, { recursive: true });
    await writeFile(path.join(VENDOR, 'parser-distribution.json'), `${JSON.stringify(distribution, null, 2)}\n`);
    process.stdout.write(`Prepared ${records.length} pinned parser packages in ${path.relative(ROOT, VENDOR)}\n`);
    if (buildMissing) process.stdout.write(`Native artifacts: ${path.relative(ROOT, path.join(ROOT, '.parser-build', tuple))}\n`);
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

async function verify(allTargets) {
  const manifestPath = path.join(VENDOR, 'parser-distribution.json');
  const distribution = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (distribution.schemaVersion !== 1 || distribution.runtime !== 'tree-sitter@0.25.1') fail('Unexpected parser distribution schema or runtime version');
  if (!Array.isArray(distribution.packages) || distribution.packages.length !== 12) fail('Distribution must include the runtime and all 11 pinned grammars');
  const packages = new Map(distribution.packages.map((pkg) => [pkg.name, pkg]));
  for (const source of packageList()) {
    const record = packages.get(source.name);
    if (!record || record.version !== source.version || record.integrity !== source.integrity || !/^[a-f0-9]{64}$/.test(record.sourceSha256)) fail(`Pinned provenance mismatch for ${source.name}`);
    if (typeof record.sourceManifest?.license !== 'string') fail(`Missing original license metadata for ${source.name}`);
    const directory = path.join(VENDOR, source.name);
    const observed = {};
    const nativeFiles = [];
    async function visit(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          const relative = path.relative(directory, absolute).split(path.sep).join('/');
          const bytes = await readFile(absolute);
          observed[relative] = digest(bytes);
          const target = /^prebuilds\/(darwin|linux|win32)-(arm64|x64)\/.+\.node$/.exec(relative);
          if (target) nativeFiles.push({ bytes, tuple: `${target[1]}-${target[2]}` });
        } else fail(`Unexpected file type in ${absolute}`);
      }
    }
    await visit(directory);
    if (JSON.stringify(Object.entries(observed).sort()) !== JSON.stringify(Object.entries(record.files).sort())) fail(`File inventory/checksum mismatch for ${source.name}`);
    const licenseFiles = Object.fromEntries(Object.entries(observed).filter(([file]) => /^(license|copying)(\.(md|txt|rst))?$/i.test(file)));
    if (Object.keys(licenseFiles).length === 0 || JSON.stringify(Object.entries(licenseFiles).sort()) !== JSON.stringify(Object.entries(record.licenseFiles ?? {}).sort())) fail(`Missing or invalid license file record for ${source.name}`);
    for (const asset of nativeFiles) machineFor(asset.bytes, asset.tuple);
    const targetSet = allTargets ? REQUIRED_TARGETS : [targetTuple()];
    for (const target of targetSet) {
      if (!record.prebuilds?.[target]?.length) fail(`Missing required native prebuild: ${source.name} (${target})`);
    }
    for (const target of Object.keys(record.prebuilds ?? {})) {
      if (!/^((darwin|linux|win32)-(arm64|x64))$/.test(target)) fail(`Invalid prebuild target in manifest: ${target}`);
      const entries = record.prebuilds[target];
      if (!Array.isArray(entries) || entries.length === 0) fail(`Empty prebuild list for ${source.name} (${target})`);
      for (const entry of entries) {
        const expectedHash = record.files[entry.file];
        if (!expectedHash || expectedHash !== entry.sha256) fail(`Prebuild checksum mismatch: ${source.name}/${entry.file}`);
      }
    }
  }
  if (allTargets) {
    for (const name of NATIVE_PACKAGES) {
      const record = packages.get(name);
      for (const target of REQUIRED_TARGETS) {
        const entries = record.prebuilds?.[target] ?? [];
        if (!entries.some(({ file }) => file.endsWith('/napi.node'))) fail(`Missing generated N-API prebuild: ${name} (${target})`);
      }
    }
  }
  process.stdout.write(`Verified ${packages.size} parser packages${allTargets ? ' for all four targets' : ` for ${targetTuple()}`}\n`);
}

function usage() {
  return 'Usage: node scripts/parser-distribution.mjs prepare --build-missing | prepare --prebuild-input DIR | verify [--all-targets]';
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare') {
    const buildMissing = args.includes('--build-missing');
    const inputIndex = args.indexOf('--prebuild-input');
    const prebuildInput = inputIndex < 0 ? undefined : args[inputIndex + 1];
    const validBuildArgs = buildMissing && args.length === 1;
    const validInputArgs = !buildMissing && inputIndex === 0 && args.length === 2 && Boolean(prebuildInput) && !prebuildInput.startsWith('--');
    if (!validBuildArgs && !validInputArgs) fail(usage());
    await prepare({ buildMissing, prebuildInput });
  } else if (command === 'verify') {
    if (args.some((arg) => arg !== '--all-targets') || args.filter((arg) => arg === '--all-targets').length > 1) fail(usage());
    await verify(args.includes('--all-targets'));
  } else fail(usage());
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`parser-distribution: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { artifactFiles, unpack };
