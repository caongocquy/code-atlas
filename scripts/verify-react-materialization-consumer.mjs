import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createDecipheriv, createHash, createCipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';

function decode(payload, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  const compressed = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
  const files = JSON.parse(gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 }));
  assert.ok(files && typeof files === 'object' && !Array.isArray(files));
  const entries = Object.entries(files);
  assert.ok(entries.length > 0 && entries.length <= 2000);
  for (const [file, content] of entries) {
    assert.ok(!path.posix.isAbsolute(file) && !file.includes('\\') && !file.includes(':') && !file.split('/').includes('..'));
    assert.ok(file !== '.git' && !file.startsWith('.git/') && !file.startsWith('.env'));
    assert.ok(typeof content === 'string' && Buffer.byteLength(content) <= 4 * 1024 * 1024);
  }
  return { entries, digest: createHash('sha256').update(compressed).digest('hex') };
}

if (process.argv.includes('--self-test')) {
  const key = Buffer.alloc(32, 7);
  const encode = (files) => {
    const iv = Buffer.alloc(12, 3);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(gzipSync(JSON.stringify(files))), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  };
  assert.deepEqual(decode(encode({ 'src/App.tsx': 'hello' }), key).entries, [['src/App.tsx', 'hello']]);
  for (const name of ['../escape', '/absolute', 'C:/drive', 'a\\b', '.env', '.git/config']) assert.throws(() => decode(encode({ [name]: 'secret' }), key));
  const corrupt = encode({ 'src/App.tsx': 'hello' });
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => decode(corrupt, key));
  process.stdout.write('Encrypted consumer input self-check passed\n');
} else {
  assert.equal(process.platform, 'win32', 'Consumer qualification requires native Windows');
  const key = Buffer.from(process.env.REACT_V162_CONSUMER_KEY ?? '', 'hex');
  assert.equal(key.length, 32);
  const payload = Buffer.from(fs.readFileSync(process.argv[2], 'utf8'), 'base64');
  const { entries, digest } = decode(payload, key);
  assert.equal(digest, process.env.REACT_V162_CONSUMER_DIGEST);
  const root = path.join(process.env.RUNNER_TEMP, 'react-v162-consumer');
  fs.mkdirSync(root, { recursive: true });
  for (const [file, content] of entries) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const cli = path.resolve('dist/cli.js');
  const run = (command) => {
    const result = spawnSync(process.execPath, [cli, command, root, '--json', ...(command === 'init' ? ['--no-guidance'] : [])], { encoding: 'utf8', timeout: 300_000 });
    assert.equal(result.status, 0, `Consumer ${command} failed`);
    return JSON.parse(result.stdout);
  };
  try {
    assert.equal(run('init').indexed, true);
    const { AtlasStore } = await import('../dist/storage/atlas/atlas.store.js');
    const { getRepositoryIdentity } = await import('../dist/core/repository/repository-identity.js');
    const { getRepositoryStatusReadOnly } = await import('../dist/core/repository/repository-status.service.js');
    const id = getRepositoryIdentity(root).id;
    const check = async () => {
      const store = new AtlasStore(path.join(root, '.codeatlas', 'atlas.db'), { readOnly: true });
      try {
        const framework = store.loadFramework(id);
        const resolved = new Set(framework.relationships.flatMap((r) => r.provenance.evidenceIds));
        const unresolved = new Set(framework.diagnostics.flatMap((d) => d.evidenceIds));
        const route = 'src/app/router/routes.tsx';
        const routes = framework.relationships.filter((r) => r.provenance.refs.some((ref) => ref.relativePath === route));
        const graph = store.loadGraph(id);
        const names = new Set(graph.nodes.filter((n) => routes.some((r) => r.target.kind === 'language' && r.target.nodeId === n.id)).map((n) => n.name));
        const lazySource = fs.readFileSync(path.join(root, 'src/app/router/lazy-pages.ts'), 'utf8');
        const lazyNames = [...lazySource.matchAll(/export const (\w+) = lazyRouteNamed\(/g)].map((m) => m[1]);
        const status = await getRepositoryStatusReadOnly(root);
        const metrics = { attempted: framework.coverage.reduce((n, c) => n + c.attempted, 0), represented: new Set([...resolved, ...unresolved]).size, resolved: resolved.size, unsupported: framework.diagnostics.filter((d) => d.outcome === 'unsupported').length, lazyRoutesResolved: lazyNames.filter((name) => names.has(name)).length, routeSitesResolved: new Set(routes.flatMap((r) => r.provenance.evidenceIds)).size, graph: status.capabilities.graph.state, lexical: status.capabilities.lexical.state, generation: store.getActiveGenerationId(id) };
        assert.equal(metrics.attempted, 1091); assert.equal(metrics.represented, 1091);
        assert.equal(metrics.resolved, 1086); assert.equal(metrics.unsupported, 5);
        assert.equal(framework.diagnostics.length, 5); assert.equal(lazyNames.length, 18);
        assert.equal(metrics.lazyRoutesResolved, 18); assert.equal(metrics.routeSitesResolved, 40);
        assert.equal(metrics.graph, 'ready'); assert.equal(metrics.lexical, 'ready');
        assert.equal(status.framework.mayBeIncomplete, true);
        return metrics;
      } finally { store.close(); }
    };
    const init = await check();
    const synced = run('sync');
    assert.ok(synced.kind === 'reused' || synced.kind === 'published');
    const sync = await check();
    fs.mkdirSync('.evidence', { recursive: true });
    const report = { platform: process.platform, node: process.version, sourceCommit: process.env.REACT_V162_CONSUMER_COMMIT, snapshotDigest: digest, init, sync, passed: true };
    fs.writeFileSync('.evidence/windows-consumer.json', JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }); }
}
