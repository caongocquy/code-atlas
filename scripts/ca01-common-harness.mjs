import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareReports } from "./ca01-v170-compare-ca01-tests.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const idKey = id => JSON.stringify([id.file, id.line, id.column, id.nesting, id.name]);

function registrations(source, file, parseSync) {
  const parsed = parseSync(source, { filename: file, configFile: false, babelrc: false,
    parserOpts: { sourceType: "module", plugins: ["typescript"] } });
  if (!parsed || parsed.errors?.length) throw new Error(`Cannot parse registration source: ${file}`);
  return parsed.program.body.flatMap(statement => {
    const call = statement.type === "ExpressionStatement" ? statement.expression : null;
    if (call?.type !== "CallExpression" || call.callee?.type !== "Identifier" || call.callee.name !== "test"
      || call.arguments[0]?.type !== "StringLiteral") return [];
    return [{ name: call.arguments[0].value, span: source.slice(call.start, call.end) }];
  });
}

function verifySource(root, sourceContract, side, parseSync) {
  const sourceBytes = readFileSync(path.join(root, sourceContract.path));
  const sourceSha256 = sha256(sourceBytes);
  const source = sourceBytes.toString("utf8");
  const expected = side === "base" ? sourceContract.baseSha256 : sourceContract.candidateSha256;
  if (sourceSha256 !== expected) throw new Error(`${side} source digest mismatch`);
  const tests = registrations(source, sourceContract.path, parseSync);
  const anchors = new Map();
  for (const registration of tests) {
    if (anchors.has(registration.name)) throw new Error(`Duplicate source registration: ${registration.name}`);
    anchors.set(registration.name, sha256(registration.span));
  }
  const actual = sourceContract.registrationSha256;
  if (!Array.isArray(sourceContract.names) || tests.length !== sourceContract.names.length
    || Object.keys(actual ?? {}).length !== sourceContract.names.length
    || new Set(sourceContract.names).size !== sourceContract.names.length
    || sourceContract.names.some(name => typeof name !== "string" || !name.trim())
    || sourceContract.names.some(name => !anchors.has(name))) throw new Error("Invalid source registration contract");
  if (sourceContract.names.some(name => anchors.get(name) !== actual[name])) {
    throw new Error(`${side} registration anchor mismatch`);
  }
  return { path: sourceContract.path, sha256: sourceSha256, registrationSha256: actual };
}

function validateProcess(process, expected, side, other) {
  if (process.revision !== expected.commit) throw new Error(`${side} revision mismatch`);
  if (process.tree !== expected.tree) throw new Error(`${side} tree mismatch`);
  if (process.error || process.signal || ![0, 1].includes(process.exitCode)) throw new Error(`${side} suite process failed`);
  if (process.node !== other.node || process.platform !== other.platform || process.arch !== other.arch) {
    throw new Error(`Incomparable runtime ${side}`);
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(process.node) || !/^\d+\.\d+\.\d+$/.test(process.tsxVersion ?? "")
    || !/^[a-f0-9]{64}$/.test(process.loaderSha256 ?? "") || process.loaderUrl !== other.loaderUrl
    || process.loaderSha256 !== other.loaderSha256 || process.tsxVersion !== other.tsxVersion) {
    throw new Error(`Unverified execution loader ${side}`);
  }
}

function allowedRuntime(contract, process) {
  const node = process.node.replace(/^v/, "");
  return contract.runtime.nodes.includes(node)
    && contract.runtime.targets.some(target => target.platform === process.platform && target.arch === process.arch);
}

export function compareCommonHarness({ contract, baseline, candidate, baselineProcess, candidateProcess,
  baselineRoot, candidateRoot, tempRoot }) {
  if (contract.schemaVersion !== 1 || !contract.base?.commit || !contract.candidate?.commit
    || !Array.isArray(contract.relocations) || contract.relocations.length !== contract.requiredRelocationCount) {
    throw new Error("Invalid common-harness contract or incomplete relocation set");
  }
  validateProcess(baselineProcess, contract.base, "baseline", candidateProcess);
  validateProcess(candidateProcess, contract.candidate, "candidate", baselineProcess);
  if (!allowedRuntime(contract, candidateProcess)) throw new Error("Unsupported runtime");
  if (baselineProcess.pnpmVersion !== contract.dependencies.pnpmVersion
    || candidateProcess.pnpmVersion !== contract.dependencies.pnpmVersion
    || baselineProcess.lockfileSha256 !== contract.dependencies.lockfileSha256
    || candidateProcess.lockfileSha256 !== contract.dependencies.lockfileSha256
    || baselineProcess.tsxVersion !== contract.execution.tsxVersion
    || candidateProcess.tsxVersion !== contract.execution.tsxVersion
    || baselineProcess.loaderSha256 !== contract.execution.loaderSha256
    || candidateProcess.loaderSha256 !== contract.execution.loaderSha256) {
    throw new Error("Execution toolchain does not match the reviewed contract");
  }
  for (const process of [baselineProcess, candidateProcess]) {
    let loaderPath;
    try { loaderPath = fileURLToPath(process.loaderUrl); }
    catch { throw new Error("Invalid absolute loader URL"); }
    if (!process.loaderUrl.startsWith("file:") || pathToFileURL(realpathSync(loaderPath)).href !== process.loaderUrl
      || sha256(readFileSync(loaderPath)) !== process.loaderSha256) throw new Error("Execution loader integrity mismatch");
  }
  const requireCandidate = createRequire(path.join(candidateRoot, "package.json"));
  const babel = requireCandidate("@babel/core");
  let babelManifest;
  let babelPackageDir = path.dirname(requireCandidate.resolve("@babel/core"));
  while (babelPackageDir !== path.dirname(babelPackageDir)) {
    try {
      const value = JSON.parse(readFileSync(path.join(babelPackageDir, "package.json"), "utf8"));
      if (value.name === "@babel/core") { babelManifest = value; break; }
    } catch { /* Continue up from the resolved entry file. */ }
    babelPackageDir = path.dirname(babelPackageDir);
  }
  if (contract.parser.package !== "@babel/core" || contract.parser.version !== "8.0.1" || babelManifest?.version !== contract.parser.version
    || typeof babel.parseSync !== "function") {
    throw new Error("Unsupported registration parser version");
  }
  const sources = {
    baseline: verifySource(baselineRoot, contract.source, "base", babel.parseSync),
    candidate: verifySource(candidateRoot, contract.source, "candidate", babel.parseSync),
  };
  const fromKeys = new Set(), toKeys = new Set(), relocationNames = new Set();
  const baseRecords = new Map(), candidateRecords = new Map();
  const recordNames = events => {
    const counts = new Map();
    for (const event of events) {
      if (event?.type !== "test:pass" && event?.type !== "test:fail") continue;
      const identity = event.identity;
      if (!identity || typeof identity.file !== "string" || !identity.file || !Number.isInteger(identity.line) || identity.line < 1
        || !Number.isInteger(identity.column) || identity.column < 1 || !Number.isInteger(identity.nesting) || identity.nesting < 0
        || typeof identity.name !== "string" || !identity.name.trim()) throw new Error("Incomplete test identity");
      const key = JSON.stringify([identity.file, identity.name]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const baseNameRecords = recordNames(baseline), candidateNameRecords = recordNames(candidate);
  for (const event of baseline) {
    if (event?.identity) baseRecords.set(idKey(event.identity), (baseRecords.get(idKey(event.identity)) ?? 0) + 1);
  }
  for (const event of candidate) {
    if (event?.identity) candidateRecords.set(idKey(event.identity), (candidateRecords.get(idKey(event.identity)) ?? 0) + 1);
  }
  const translated = new Map();
  for (const mapping of contract.relocations) {
    const from = idKey(mapping.from), to = idKey(mapping.to);
    if (fromKeys.has(from)) throw new Error("Duplicate relocation source");
    if (toKeys.has(to)) throw new Error("Duplicate relocation target");
    if (from === to || mapping.from.file !== contract.source.path || mapping.to.file !== contract.source.path
      || mapping.from.name !== mapping.to.name || typeof mapping.from.name !== "string" || !mapping.from.name.trim()
      || !Number.isInteger(mapping.from.line) || mapping.from.line < 1 || !Number.isInteger(mapping.from.column) || mapping.from.column < 1
      || !Number.isInteger(mapping.to.line) || mapping.to.line < 1 || !Number.isInteger(mapping.to.column) || mapping.to.column < 1
      || !Number.isInteger(mapping.from.nesting) || mapping.from.nesting < 0 || !Number.isInteger(mapping.to.nesting) || mapping.to.nesting < 0) throw new Error("Invalid relocation identity");
    if (relocationNames.has(mapping.from.name) || !contract.source.names.includes(mapping.from.name)) {
      throw new Error("Relocation names must bijectively match reviewed source registrations");
    }
    if (baseRecords.get(from) !== 1) throw new Error("Baseline relocation source must occur exactly once");
    if (candidateRecords.get(to) !== 1) throw new Error("Candidate relocation target must occur exactly once");
    if (baseNameRecords.get(JSON.stringify([mapping.from.file, mapping.from.name])) !== 1
      || candidateNameRecords.get(JSON.stringify([mapping.to.file, mapping.to.name])) !== 1) {
      throw new Error("Relocated registration must occur exactly once in each raw report");
    }
    if (candidateRecords.has(from)) throw new Error("Candidate relocation source identity is ambiguous");
    if (baseRecords.has(to)) throw new Error("Relocation target collides with a baseline identity");
    fromKeys.add(from); toKeys.add(to); relocationNames.add(mapping.from.name); translated.set(to, mapping.from);
  }
  if (relocationNames.size !== contract.source.names.length
    || contract.source.names.some(name => !relocationNames.has(name))) {
    throw new Error("Relocation set is incomplete for reviewed source registrations");
  }
  const mappedCandidate = candidate.map(event => {
    if (!event.identity) return event;
    const identity = translated.get(idKey(event.identity));
    return identity ? { ...event, identity } : event;
  });
  const result = compareReports(baseline, mappedCandidate, {
    baseline: { root: baselineRoot, tempRoot }, candidate: { root: candidateRoot, tempRoot },
  });
  if ((baselineProcess.exitCode === 0) !== result.strictGreen.baseline
    || (candidateProcess.exitCode === 0) !== result.strictGreen.candidate) throw new Error("Process exit and test summary disagree");
  return {
    ...result,
    relocations: contract.relocations.map(({ from, to }) => ({ from, to })),
    sourceBindings: sources,
    execution: {
      node: candidateProcess.node, platform: candidateProcess.platform, arch: candidateProcess.arch,
      loaderUrl: candidateProcess.loaderUrl, loaderSha256: candidateProcess.loaderSha256, tsxVersion: candidateProcess.tsxVersion,
    },
    revisions: { base: contract.base, candidate: contract.candidate },
  };
}

function readJsonLines(prefix) {
  return readFileSync(`${prefix}.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [contractPath, baselinePrefix, candidatePrefix, baselineRoot, candidateRoot, tempRoot, contractSha] = process.argv.slice(2);
  if (![contractPath, baselinePrefix, candidatePrefix, baselineRoot, candidateRoot, tempRoot, contractSha].every(Boolean)) {
    throw new Error("Usage: ca01-common-harness.mjs <contract.json> <baseline-prefix> <candidate-prefix> <base-root> <candidate-root> <temp-root> <contract-sha256>");
  }
  const contractBytes = readFileSync(contractPath);
  if (sha256(contractBytes) !== contractSha) throw new Error("Trusted common-harness contract digest mismatch");
  const baselineProcess = JSON.parse(readFileSync(`${baselinePrefix}.process.json`, "utf8"));
  const candidateProcess = JSON.parse(readFileSync(`${candidatePrefix}.process.json`, "utf8"));
  const baselineBytes = readFileSync(`${baselinePrefix}.jsonl`), candidateBytes = readFileSync(`${candidatePrefix}.jsonl`);
  if (sha256(baselineBytes) !== baselineProcess.eventsSha256 || sha256(candidateBytes) !== candidateProcess.eventsSha256) {
    throw new Error("Raw test report digest mismatch");
  }
  const result = compareCommonHarness({ contract: JSON.parse(contractBytes), baseline: readJsonLines(baselinePrefix),
    candidate: readJsonLines(candidatePrefix), baselineProcess, candidateProcess, baselineRoot, candidateRoot, tempRoot });
  result.rawReports = { baselineSha256: baselineProcess.eventsSha256, candidateSha256: candidateProcess.eventsSha256 };
  const output = process.env.CA01_COMPARISON_OUTPUT;
  if (!output) throw new Error("CA01_COMPARISON_OUTPUT is required");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ differentialPass: result.differentialPass, strictGreen: result.strictGreen,
    relocated: result.relocations.length, added: result.addedFailures.length, changed: result.changedFailures.length,
    missing: result.missingTests.length, newSkips: result.newSkips.length, newTodos: result.newTodos.length }) + "\n");
  if (!result.differentialPass) process.exitCode = 1;
}
