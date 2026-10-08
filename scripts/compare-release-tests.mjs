#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ASSERTION_FIELDS = ['expected', 'actual', 'operator', 'error'];

function scalar(value) {
  const text = value.trim();
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith('"')) {
    try { return JSON.parse(text); } catch { return text; }
  }
  if (text.startsWith("'")) return text.slice(1, text.endsWith("'") ? -1 : undefined).replaceAll("''", "'");
  return text;
}

function parseTap(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const failures = [];
  const skips = [];
  const summary = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const summaryMatch = /^# (tests|pass|fail|skipped|cancelled|todo) (\d+)$/.exec(line);
    if (summaryMatch) summary[summaryMatch[1]] = Number(summaryMatch[2]);
    const skipMatch = /^\s*ok (\d+) - (.*?)\s+# SKIP(?:\s+(.*))?$/.exec(line);
    if (skipMatch) skips.push({ name: skipMatch[2], reason: skipMatch[3] ?? '' });
    const testMatch = /^(\s*)not ok (\d+)(?: - (.*))?$/.exec(line);
    if (!testMatch) continue;

    const indent = testMatch[1].length;
    const item = { name: testMatch[3] ?? `unnamed test ${testMatch[2]}`, fields: {} };
    if (lines[i + 1]?.trim() === '---') {
      i += 2;
      const yamlIndent = indent + 2;
      for (; i < lines.length; i += 1) {
        const yamlLine = lines[i];
        const lineIndent = yamlLine.length - yamlLine.trimStart().length;
        if (yamlLine.trim() === '...' && lineIndent === yamlIndent) break;
        if (lineIndent !== yamlIndent) continue;
        const fieldMatch = /^\s*([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(yamlLine);
        if (!fieldMatch) continue;
        const [, key, rawValue = ''] = fieldMatch;
        const block = /^(?:[|>])(?:[-+])?$/.test(rawValue);
        const nested = rawValue === '' && lines[i + 1] !== undefined
          && (lines[i + 1].length - lines[i + 1].trimStart().length) > yamlIndent;
        if (block || nested) {
          const content = [];
          let j = i + 1;
          let contentIndent = Infinity;
          while (j < lines.length) {
            const next = lines[j];
            const nextIndent = next.length - next.trimStart().length;
            if (next.trim() && nextIndent <= yamlIndent) break;
            if (next.trim()) contentIndent = Math.min(contentIndent, nextIndent);
            content.push(next);
            j += 1;
          }
          const body = content.map(entry => entry.trim() ? entry.slice(contentIndent) : '').join('\n');
          item.fields[key] = block ? body + (rawValue === '|' ? '\n' : '') : body;
          i = j - 1;
        } else {
          item.fields[key] = scalar(rawValue);
        }
      }
    }
    failures.push(item);
  }
  return { failures, skips, summary };
}

function normalizeText(value, roots = []) {
  let text = String(value ?? '');
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) {
    const windowsRoot = /^[A-Za-z]:[\\/]/.test(root) ? root : null;
    const nativeRoot = windowsRoot ? root : path.resolve(root);
    for (const spelling of new Set([nativeRoot, nativeRoot.replaceAll('\\', '/'), nativeRoot.replaceAll('/', '\\')])) {
      text = text.replaceAll(spelling, '<ROOT>');
    }
  }
  return text
    .replace(/(?:[A-Z]:)?[\\/](?:Users[\\/][^\\/]+[\\/])?AppData[\\/]Local[\\/]Temp[\\/][^\\s:'"),]*/gi, '<TMP>\\')
    .replace(/(?:[A-Z]:)?[\\/]Windows[\\/]Temp[\\/][^\\s:'"),]*/gi, '<TMP>\\')
    .replace(/\/var\/folders\/[^/]+\/[^/]+\/T\/(?:[^\s:'"),]+\/?)+/g, '<TMP>/')
    .replace(/\/(?:private\/)?tmp\/(?:[^\s:'"),]+\/?)+/g, '<TMP>/');
}

function failureIdentity(item, roots = []) {
  const location = normalizeText(item.fields.location ?? '', roots);
  const source = /(?:^|[\\/])(test[\\/].+?\.test\.[^\\/.:]+)(?::\d+:\d+)?$/.exec(location)?.[1]
    ?? /(?:^|[\\/])([^\\/:]+\.test\.[^\\/:]+)(?::\d+:\d+)?$/.exec(location)?.[1]
    ?? '<unknown-file>';
  const testFile = source.replaceAll('\\', '/');
  return `${testFile} :: ${normalizeText(item.name, roots)}`;
}

function assertion(item, roots = []) {
  const result = {};
  for (const field of ASSERTION_FIELDS) {
    if (field in item.fields) result[field] = normalizeText(item.fields[field], roots);
  }
  for (const [source, target] of [['code', 'errorCode'], ['name', 'errorName']]) {
    if (source in item.fields) result[target] = normalizeText(item.fields[source], roots);
  }
  return result;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function compareParsed(baseline, candidate, roots = []) {
  const failureIndex = parsed => {
    const groups = new Map();
    for (const item of parsed.failures) {
      const identity = failureIdentity(item, roots);
      const entry = { identity, assertion: assertion(item, roots) };
      const group = groups.get(identity) ?? [];
      group.push(entry);
      groups.set(identity, group);
    }
    return groups;
  };
  const before = failureIndex(baseline);
  const after = failureIndex(candidate);
  const resolved = [];
  const added = [];
  const changed = [];
  for (const identity of new Set([...before.keys(), ...after.keys()])) {
    const oldItems = [...(before.get(identity) ?? [])];
    const newItems = [...(after.get(identity) ?? [])];
    for (let i = oldItems.length - 1; i >= 0; i -= 1) {
      const signature = stable(oldItems[i].assertion);
      const match = newItems.findIndex(item => stable(item.assertion) === signature);
      if (match >= 0) { oldItems.splice(i, 1); newItems.splice(match, 1); }
    }
    const paired = Math.min(oldItems.length, newItems.length);
    for (let i = 0; i < paired; i += 1) changed.push({ identity, baseline: oldItems[i].assertion, candidate: newItems[i].assertion });
    for (const item of oldItems.slice(paired)) resolved.push({ identity, assertion: item.assertion });
    for (const item of newItems.slice(paired)) added.push({ identity, assertion: item.assertion });
  }

  const skipCounts = parsed => {
    const counts = new Map();
    for (const item of parsed.skips ?? []) {
      const key = `${normalizeText(item.name, roots)}\u0000${normalizeText(item.reason, roots)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const priorSkips = skipCounts(baseline);
  const nextSkips = skipCounts(candidate);
  const addedSkips = [];
  const resolvedSkips = [];
  for (const [key, count] of nextSkips) {
    const extra = count - (priorSkips.get(key) ?? 0);
    if (extra > 0) addedSkips.push({ name: key.split('\u0000')[0], count: extra });
  }
  for (const [key, count] of priorSkips) {
    const missing = count - (nextSkips.get(key) ?? 0);
    if (missing > 0) resolvedSkips.push({ name: key.split('\u0000')[0], count: missing });
  }

  const summaryConsistent = parsed => ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'].every(key => key in parsed.summary)
    && parsed.summary.fail === parsed.failures.length
    && parsed.summary.skipped === (parsed.skips ?? []).length
    && parsed.summary.tests === parsed.summary.pass + parsed.summary.fail + parsed.summary.skipped + parsed.summary.cancelled + parsed.summary.todo;
  const baselineValid = summaryConsistent(baseline);
  const candidateValid = summaryConsistent(candidate) && candidate.summary.cancelled === 0
    && candidate.summary.todo <= (baseline.summary.todo ?? 0);
  return {
    passed: baselineValid && candidateValid && added.length === 0 && changed.length === 0 && addedSkips.length === 0,
    baseline: { summary: baseline.summary, failureRecords: baseline.failures.length, skippedRecords: (baseline.skips ?? []).length },
    candidate: { summary: candidate.summary, failureRecords: candidate.failures.length, skippedRecords: (candidate.skips ?? []).length },
    added,
    changed,
    resolved,
    addedSkips,
    resolvedSkips,
    diagnostics: {
      baselineSummaryMatchesRecords: baselineValid,
      candidateSummaryMatchesRecords: summaryConsistent(candidate),
      candidateHasNoCancelledTests: candidate.summary.cancelled === 0,
      candidateHasNoNewTodoTests: candidate.summary.todo <= (baseline.summary.todo ?? 0),
    },
  };
}

export { parseTap, normalizeText, failureIdentity, assertion, compareParsed };

function main(argv) {
  const args = [...argv];
  const roots = [];
  while (args[0] === '--normalize-root') { args.shift(); roots.push(args.shift()); }
  const [baselinePath, candidatePath, reportPath] = args;
  if (!baselinePath || !candidatePath) {
    process.stderr.write('Usage: node code-atlas-release-regression-compare.mjs [--normalize-root PATH]... baseline.tap candidate.tap [report.json]\n');
    return 2;
  }
  const baseline = parseTap(fs.readFileSync(baselinePath, 'utf8'));
  const candidate = parseTap(fs.readFileSync(candidatePath, 'utf8'));
  const report = compareParsed(baseline, candidate, roots);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) fs.writeFileSync(reportPath, output);
  else process.stdout.write(output);
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
