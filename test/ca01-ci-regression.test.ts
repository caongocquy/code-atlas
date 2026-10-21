import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
// This is dependency-free CI tooling, also executable directly by Node on runners.
// @ts-expect-error JavaScript tooling intentionally has no generated declaration files.
import { compareReports } from "../scripts/compare-ca01-tests.mjs";

// @ts-expect-error JavaScript tooling intentionally has no generated declaration files.
import report from "../scripts/ca01-test-reporter.mjs";

const identity = { file: "test/existing.test.ts", line: 10, column: 1, nesting: 0, name: "contract" };
const error = { name: "AssertionError", code: "ERR_ASSERTION", actual: 1, expected: 2, stack: "at run (/baseline/src/file.ts:12:3)", cause: { code: "ROOT", message: "cause" } };
const locations = { baseline: { root: "/baseline", tempRoot: "/tmp" }, candidate: { root: "/candidate", tempRoot: "/tmp" } };
const record = (changes = {}) => ({ type: "test:fail", identity, skip: false, todo: false, error, ...changes });
const events = (records: ReturnType<typeof record>[]) => [...records, ...Object.entries({ tests: records.length,
  pass: records.filter(r => r.type === "test:pass" && !r.skip).length, fail: records.filter(r => r.type === "test:fail").length,
  cancelled: 0, skipped: records.filter(r => r.skip).length, todo: 0 }).map(([key, value]) => ({ type: "test:diagnostic", message: `${key} ${value}` }))];
const compare = (a: ReturnType<typeof events>, b: ReturnType<typeof events>) => compareReports(a, b, locations);

test("CA-01 CI reports strict failure separately from equivalent baseline debt", () => {
  const result = compare(events([record()]), events([record({ error: { ...error, stack: "at run (/candidate/src/file.ts:12:3)" } })]));
  assert.equal(result.differentialPass, true);
  assert.deepEqual(result.strictGreen, { baseline: false, candidate: false });
});
for (const [name, changed] of Object.entries({ actual: { ...error, actual: 3 }, expected: { ...error, expected: 3 }, code: { ...error, code: "OTHER" },
  cause: { ...error, cause: { code: "OTHER", message: "cause" } }, stack: { ...error, stack: "at run (/candidate/src/file.ts:13:3)" } })) {
  test(`CA-01 CI rejects changed ${name}`, () => assert.equal(compare(events([record()]), events([record({ error: changed })])).differentialPass, false));
}
test("CA-01 CI rejects new skips, missing tests and changed test identity", () => {
  const before = events([record({ type: "test:pass" })]);
  assert.equal(compare(before, events([record({ type: "test:pass", skip: true })])).differentialPass, false);
  assert.equal(compare(before, events([])).differentialPass, false);
  assert.equal(compare(before, events([record({ type: "test:pass", identity: { ...identity, name: "replacement" } })])).differentialPass, false);
});
test("CA-01 CI rejects a new failure and a newly failing CA-01 test", () => {
  assert.equal(compare(events([]), events([record({ identity: { ...identity, file: "test/ca01-mcp-response.test.ts" } })])).differentialPass, false);
  assert.equal(compare(events([record({ type: "test:pass" })]), events([record()])).differentialPass, false);
});
test("CA-01 CI accepts added passing tests without hardcoding baseline failure count", () => {
  assert.equal(compare(events([]), events([record({ type: "test:pass" })])).differentialPass, true);
});
test("CA-01 CI preserves UUID equality and only normalizes recorded temporary paths", () => {
  const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
  const a = { message: `/tmp/code-atlas-case-ABC123/source.ts ${first} ${first}` };
  const b = { message: `/tmp/code-atlas-case-DEF456/source.ts ${second} ${second}` };
  assert.equal(compare(events([record({ error: a })]), events([record({ error: b })])).differentialPass, true);
  assert.equal(compare(events([record({ error: a })]), events([record({ error: { message: `${b.message} ${first}` } })])).differentialPass, false);
});
test("CA-01 CI fails closed on duplicate identities and incomplete suite data", () => {
  assert.throws(() => compare(events([record(), record()]), events([])), /Duplicate/);
  assert.throws(() => compare([], []), /Incomplete/);
});

test("CA-01 CI handles Windows roots and rejects checkout-prefix lookalikes", () => {
  const win = { baseline: { root: "D:\\a\\base", tempRoot: "C:\\Temp" }, candidate: { root: "D:\\a\\candidate", tempRoot: "C:\\Temp" } };
  const a = events([record({ error: { stack: "at D:\\a\\base\\src\\a.ts:4:1" } })]);
  const b = events([record({ error: { stack: "at D:\\a\\candidate\\src\\a.ts:4:1" } })]);
  assert.equal(compareReports(a, b, win).differentialPass, true);
  assert.equal(compare(events([record({ error: { message: "path evidence", actual: "/baselineOTHER" } })]), events([record({ error: { message: "path evidence", actual: "/candidateOTHER" } })])).differentialPass, false);
});

for (const malformed of [undefined, null, false, "error", [], {}, { $type: "undefined" }, { name: "Error" }, { message: " " }, { message: 42 }, { stack: {} }]) {
  test(`CA-01 CI rejects equivalent unusable error evidence: ${JSON.stringify(malformed)}`, () => {
    const data = events([record({ error: malformed })]);
    assert.throws(() => compare(data, data), /error evidence/);
  });
}
test("CA-01 reporter fails closed before emitting a failure without evidence", async () => {
  async function* input() { yield { type: "test:fail", data: { file: "test/x.ts", name: "missing", details: {} } }; }
  await assert.rejects(async () => { for await (const _line of report(input())) { assert.fail("must not emit missing evidence"); } }, /error evidence/);
});
for (const counter of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
  test(`CA-01 CI rejects inaccurate ${counter} summary`, () => {
    const data = events([record({ type: "test:pass", skip: "reason" })]);
    const invalid = data.map(row => "message" in row && row.message.startsWith(`${counter} `)
      ? { ...row, message: `${counter} ${counter === "skipped" || counter === "tests" ? 0 : 1}` } : row);
    assert.throws(() => compare(invalid, invalid), /summary|cancelled/i);
  });
}
test("CA-01 CI rejects duplicate summaries and malformed disposition flags", () => {
  const data = events([]);
  assert.throws(() => compare([...data, { type: "test:diagnostic", message: "pass 0" }], data), /Duplicate suite summary/);
  for (const skip of [null, 1, {}, []]) assert.throws(() => compare(events([record({ skip })]), data), /disposition/);
});
test("CA-01 CI counts passing and failing todo events separately from pass and fail", () => {
  const records = [record({ type: "test:pass", todo: true }), record({ todo: "later", error: { message: "expected todo" }, identity: { ...identity, name: "todo failure" } })];
  const data = [...records, ...Object.entries({ tests: 2, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 2 })
    .map(([key, value]) => ({ type: "test:diagnostic", message: `${key} ${value}` }))];
  assert.equal(compare(data, data).differentialPass, true);
  assert.throws(() => compare(data.map(row => "message" in row && row.message === "todo 2" ? { ...row, message: "todo 1" } : row), data), /summary/);
});

test("CA-01 CI requires every summary counter and rejects malformed todo flags", () => {
  const data = events([record({ type: "test:pass" })]);
  for (const counter of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const incomplete = data.filter(row => !("message" in row && row.message.startsWith(`${counter} `)));
    assert.throws(() => compare(incomplete, incomplete), /Incomplete/);
  }
  for (const todo of [null, 1, {}, []]) assert.throws(() => compare(events([record({ todo })]), data), /disposition/);
});

test("CA-01 Windows suite launcher preserves literal paths and CRLF", () => {
  const workflow = readFileSync(new URL("../.github/workflows/tree-sitter-installation.yml", import.meta.url), "utf8");
  const launcher = workflow.split("\n").find(line => line.includes("printf '%s\\r\\n' '@echo off'"));
  assert.ok(launcher);
  const result = spawnSync("bash", ["-c", launcher.split(" > ")[0]!], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '@echo off\r\nnode "%~dp0..\\..\\dist\\cli.js" %*\r\n');
});
