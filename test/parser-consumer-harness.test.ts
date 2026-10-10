import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  APPROVALS,
  assertApprovedEvidence,
  approvedLogFindings,
  classifyInstallLog,
  compilerGuardSource,
  createConsumerConfig,
  isBlockedCompilerCommand,
  npmConfigFiles,
  supportsNpmAllowScripts,
} from '../scripts/test-parser-consumer.mjs';

const cleanManifest = { dependencies: { 'node-gyp-build': '4.8.4' } };
const cleanGraph = { dependencies: { '@showdar2112/code-atlas': { dependencies: { 'node-gyp-build': { version: '4.8.4' } } } } };


test('consumer policy approves exactly ONNX and protobufjs', () => {
  const npm = createConsumerConfig({ manager: 'npm', mode: 'approved', tarball: '/tmp/code-atlas.tgz' });
  assert.deepEqual(npm.manifest.allowScripts, {
    'onnxruntime-node@1.30.0': true,
    'protobufjs@7.6.6': true,
  });
  assert.deepEqual(Object.keys(APPROVALS).sort(), ['onnxruntime-node', 'protobufjs']);
  assert.equal(createConsumerConfig({ manager: 'npm', mode: 'default', tarball: '/tmp/code-atlas.tgz' }).manifest.allowScripts, undefined);

  const pnpm = createConsumerConfig({ manager: 'pnpm', mode: 'approved', tarball: '/tmp/code-atlas.tgz' });
  assert.equal(pnpm.pnpmWorkspace, 'sideEffectsCache: false\nallowBuilds:\n  "onnxruntime-node": true\n  "protobufjs": true\n');
  assert.equal(createConsumerConfig({ manager: 'pnpm', mode: 'default', tarball: '/tmp/code-atlas.tgz' }).pnpmWorkspace, 'sideEffectsCache: false\n');
});

test('consumer workflow selects exactly one nested tarball on Bash 3-compatible syntax', () => {
  const workflow = readFileSync(new URL('../.github/workflows/tree-sitter-installation.yml', import.meta.url), 'utf8');
  const lines = workflow.split(/\r?\n/);
  const stepStart = lines.indexOf('      - name: Select the packed package');
  assert.notEqual(stepStart, -1);
  const runStart = lines.indexOf('        run: |', stepStart);
  assert.notEqual(runStart, -1);
  const scriptLines = [];
  for (let index = runStart + 1; index < lines.length && !lines[index].startsWith('      - name: '); index += 1) {
    if (lines[index].startsWith('          ')) scriptLines.push(lines[index].slice(10));
  }
  const selector = scriptLines.join('\n');
  assert.ok(selector.includes("find .consumer-artifact -type f -name '*.tgz' -print"));
  assert.ok(selector.includes('test -n "$package"'));
  assert.ok(selector.includes('wc -l'));

  for (const count of [0, 1, 2]) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'parser-tarball-selector-'));
    try {
      const packageDirectory = path.join(root, '.consumer-artifact', '.artifact');
      mkdirSync(packageDirectory, { recursive: true });
      for (let index = 0; index < count; index += 1) {
        writeFileSync(path.join(packageDirectory, 'package-' + index + '.tgz'), 'fixture');
      }
      const githubEnv = path.join(root, 'github-env');
      const child = spawnSync(process.platform === 'win32' ? 'bash' : '/bin/bash', ['-e', '-o', 'pipefail', '-c', selector], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_WORKSPACE: root, GITHUB_ENV: githubEnv },
      });
      if (count === 1) {
        assert.equal(child.status, 0, child.stderr);
        assert.ok(readFileSync(githubEnv, 'utf8').includes(root + '/.consumer-artifact/.artifact/package-0.tgz'));
      } else {
        assert.notEqual(child.status, 0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('Windows release-suite launchers preserve escaped backslashes and CRLF', () => {
  const workflow = readFileSync(new URL('../.github/workflows/tree-sitter-installation.yml', import.meta.url), 'utf8');
  const launchers = workflow.split('\n').filter((line) => line.includes("printf '@echo off"));
  assert.equal(launchers.length, 2);
  for (const launcher of launchers) {
    assert.ok(launcher.includes(String.raw`%%~dp0..\\..\\dist\\cli.js`));
    assert.ok(launcher.includes(String.raw`\r\n`));
  }
});

test('npm accepts separate empty user and global config files', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'parser-npm-config-'));
  try {
    const configs = npmConfigFiles(root);
    writeFileSync(configs.user, '');
    writeFileSync(configs.global, '');
    assert.notEqual(configs.user, configs.global);

    const windows = process.platform === 'win32';
    const child = spawnSync(windows ? 'cmd.exe' : 'npm', windows ? ['/d', '/s', '/c', 'npm --version'] : ['--version'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_userconfig: configs.user,
        npm_config_globalconfig: configs.global,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /^\d+\.\d+\.\d+/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('npm 10 runs lifecycle hooks without enforcing allowScripts; npm 11 supports approval metadata', () => {
  assert.equal(supportsNpmAllowScripts('10.9.4'), false);
  assert.equal(supportsNpmAllowScripts('11.1.0'), true);
});

test('approved evidence requires a successful graph and rejects parser package edges', () => {
  assert.equal(assertApprovedEvidence({
    install: { exitCode: 0 },
    parser: { exitCode: 0 },
    graph: { exitCode: 0 },
    installLog: 'npm warn deprecated harmless-package@1.0.0',
    manifest: cleanManifest,
    graphJson: cleanGraph,
  }), true);
  assert.throws(() => assertApprovedEvidence({
    install: { exitCode: 0 },
    parser: { exitCode: 0 },
    graph: { exitCode: 1 },
    installLog: '',
    manifest: cleanManifest,
    graphJson: cleanGraph,
  }), /Dependency graph command failed/);
  assert.throws(() => assertApprovedEvidence({
    install: { exitCode: 0 },
    parser: { exitCode: 0 },
    graph: { exitCode: 0 },
    installLog: '',
    manifest: cleanManifest,
    graphJson: {},
  }), /Dependency graph JSON is missing or empty/);
  for (const graphJson of [
    { dependencies: { 'tree-sitter-cli': { version: '0.23.2' } } },
    { peerDependencies: { 'tree-sitter-kotlin': '^0.3.8' } },
    { dependencies: { '@driftlog/tree-sitter-dart': { version: '1.0.4' } } },
    [{ name: 'tree-sitter-typescript', version: '0.23.2', peer: true }],
  ]) {
    assert.throws(() => assertApprovedEvidence({
      install: { exitCode: 0 },
      parser: { exitCode: 0 },
      graph: { exitCode: 0 },
      installLog: '',
      manifest: cleanManifest,
      graphJson,
    }), /Production parser package edges remain/);
  }
});

test('approved install warnings are classified and fail only the reviewed warning categories', () => {
  const log = [
    'npm warn ERESOLVE overriding peer dependency',
    'WARN Issues with peer dependencies found',
    'npm warn install-scripts 2 packages have install scripts not yet covered by allowScripts',
    'ERR_PNPM_IGNORED_BUILDS Ignored build scripts: tree-sitter-kotlin',
    'No native build was found for platform=win32 arch=x64',
    'CXX(target) Release/obj.target/parser/binding.o',
    "warning: unused function 'skip'",
    'npm warn deprecated harmless-package@1.0.0',
  ].join('\n');
  const classified = classifyInstallLog(log);
  assert.equal(classified.peerWarnings.length, 2);
  assert.equal(classified.lifecyclePolicyWarnings.length, 2);
  assert.equal(classified.nativePrebuildErrors.length, 1);
  assert.equal(classified.compilationWarnings.length, 2);
  assert.equal(classified.deprecatedWarnings.length, 1);
  assert.equal(approvedLogFindings('npm warn deprecated harmless-package@1.0.0').length, 0);
  assert.throws(() => assertApprovedEvidence({
    install: { exitCode: 0 },
    parser: { exitCode: 0 },
    graph: { exitCode: 0 },
    installLog: log,
    manifest: cleanManifest,
    graphJson: cleanGraph,
  }), /peer, lifecycle-policy/);
});

test('compiler guard detects explicit Windows cl.exe paths, including shell arguments', () => {
  const compilerPath = String.raw`C:\Program Files\Microsoft Visual Studio\VC\Tools\cl.exe`;
  assert.equal(isBlockedCompilerCommand(compilerPath), true);
  assert.equal(isBlockedCompilerCommand('node-gyp-build'), false);

  const root = mkdtempSync(path.join(os.tmpdir(), 'parser-consumer-guard-'));
  try {
    const event = path.join(root, 'compiler-invocations.log');
    const preload = path.join(root, 'guard.cjs');
    writeFileSync(preload, compilerGuardSource(event));
    const childCode = `require('node:child_process').spawn('cmd.exe', ['/c', ${JSON.stringify(compilerPath)}]);`;
    const child = spawnSync(process.execPath, ['-e', childCode], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` },
    });
    assert.notEqual(child.status, 0);
    assert.match(String(readFileSync(event, 'utf8')), /cl cmd\.exe.*cl\.exe/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumer version gate follows the checkout package metadata', () => {
  const harness = readFileSync(new URL('../scripts/test-parser-consumer.mjs', import.meta.url), 'utf8');
  assert.ok(harness.includes('assert.equal(result.packageVersion, JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version'));
  assert.ok(!harness.includes('assert.equal(result.packageVersion, "1.6.0"'));
});
