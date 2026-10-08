import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTap, normalizeText, compareParsed } from '../scripts/compare-release-tests.mjs';

const tap = (name, fields, { pass = 0, skipped = 0, file = '/tmp/run/test/sample.test.ts:4:3' } = {}) => `TAP version 13\n# Subtest: ${name}\nnot ok 1 - ${name}\n  ---\n  duration_ms: 1\n  type: 'test'\n  location: '${file}'\n${fields}\n  ...\n1..1\n# tests ${pass + skipped + 1}\n# pass ${pass}\n# fail 1\n# skipped ${skipped}\n# cancelled 0\n# todo 0\n`;
const assertionFields = ({ expected = 'new', actual = 'old', operator = 'strictEqual', error = 'Expected values to be strictly equal' } = {}) => `  failureType: 'testCodeFailure'\n  error: |-\n    ${error}\n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected: '${expected}'\n  actual: '${actual}'\n  operator: '${operator}'`;

test('extracts failed identity and assertion values from TAP diagnostics', () => {
  const parsed = parseTap(tap('keeps baseline behavior', assertionFields()));
  assert.equal(parsed.summary.fail, 1);
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0].fields.expected, 'new');
  assert.equal(parsed.failures[0].fields.actual, 'old');
  assert.equal(parsed.failures[0].fields.operator, 'strictEqual');
  assert.match(parsed.failures[0].fields.error, /Expected values/);
});

test('retains nested YAML values for expected and actual', () => {
  const parsed = parseTap(tap('nested assertion', `  expected:\n    status: 'ready'\n    count: 2\n  actual:\n    status: 'stale'\n    count: 2\n  operator: 'deepStrictEqual'`));
  assert.match(parsed.failures[0].fields.expected, /status: 'ready'/);
  assert.match(parsed.failures[0].fields.actual, /status: 'stale'/);
});

test('accepts an unchanged baseline failure with only checkout roots changed', () => {
  const before = parseTap(tap('keeps baseline behavior', assertionFields(), { file: '/private/tmp/base/test/sample.test.ts:4:3' }));
  const after = parseTap(tap('keeps baseline behavior', assertionFields(), { file: '/private/tmp/candidate/test/sample.test.ts:4:3' }));
  const report = compareParsed(before, after, ['/private/tmp/base', '/private/tmp/candidate']);
  assert.equal(report.passed, true);
  assert.equal(report.added.length, 0);
  assert.equal(report.changed.length, 0);
});

test('fails when an existing failed test changes its assertion outcome', () => {
  const before = parseTap(tap('keeps baseline behavior', assertionFields()));
  const after = parseTap(tap('keeps baseline behavior', assertionFields({ expected: 'connected', actual: 'stale' })));
  const report = compareParsed(before, after);
  assert.equal(report.passed, false);
  assert.equal(report.changed.length, 1);
  assert.deepEqual(report.changed[0].candidate, {
    expected: 'connected', actual: 'stale', operator: 'strictEqual', error: 'Expected values to be strictly equal',
    errorCode: 'ERR_ASSERTION', errorName: 'AssertionError',
  });
});

test('fails when the same suite adds another assertion failure', () => {
  const before = parseTap(tap('keeps baseline behavior', assertionFields()));
  const second = `\nnot ok 2 - another assertion\n  ---\n  expected: 1\n  actual: 2\n  operator: 'strictEqual'\n  ...\n`;
  const one = tap('keeps baseline behavior', assertionFields());
  const two = `${one.split('1..1')[0]}${second}1..2\n# tests 2\n# pass 0\n# fail 2\n# skipped 0\n# cancelled 0\n# todo 0\n`;
  const report = compareParsed(before, parseTap(two));
  assert.equal(report.passed, false);
  assert.equal(report.added.length, 1);
});

test('rejects a newly skipped test and reports its identity', () => {
  const before = parseTap(`TAP version 13\nnot ok 1 - old failure\n  ---\n  expected: 1\n  actual: 2\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n# cancelled 0\n# todo 0\n`);
  const after = parseTap(`TAP version 13\nnot ok 1 - old failure\n  ---\n  expected: 1\n  actual: 2\n  ...\nok 2 - newly skipped # SKIP newly hidden\n1..2\n# tests 2\n# pass 0\n# fail 1\n# skipped 1\n# cancelled 0\n# todo 0\n`);
  const report = compareParsed(before, after);
  assert.equal(report.passed, false);
  assert.deepEqual(report.addedSkips, [{ name: 'newly skipped', count: 1 }]);
});

test('allows a complete all-green baseline', () => {
  const green = parseTap(`TAP version 13\nok 1 - passed\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n`);
  assert.equal(compareParsed(green, green).passed, true);
});

test('normalizes Windows roots and temp paths while preserving regular paths', () => {
  assert.equal(normalizeText('C:\\a\\work\\repo\\test\\x.ts', ['C:\\a\\work\\repo']), '<ROOT>\\test\\x.ts');
  assert.match(normalizeText('C:\\Users\\runner\\AppData\\Local\\Temp\\run-123\\file.ts'), /<TMP>/);
  assert.equal(normalizeText('expected /Users/leo/project/file.ts'), 'expected /Users/leo/project/file.ts');
});

test('rejects incomplete TAP logs and hidden cancellations', () => {
  const incomplete = parseTap('TAP version 13\nnot ok 1 - test\n');
  assert.equal(compareParsed(incomplete, incomplete).passed, false);
  const canceled = parseTap(`TAP version 13\nok 1 - passed\n1..1\n# tests 1\n# pass 0\n# fail 0\n# skipped 0\n# cancelled 1\n# todo 0\n`);
  assert.equal(compareParsed(canceled, canceled).passed, false);
});
