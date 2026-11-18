import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { goFactExtractor } from "../src/core/facts/extractors/go.js";
import { factExtractorInput } from "./helpers/phase14b-language-fixtures.js";

test("Go method receiver is recorded once across repeated tree-sitter node wrappers", () => {
  const source = readFileSync(new URL("./fixtures/phase14b/go/main.go", import.meta.url), "utf8");
  const input = factExtractorInput({ filePath: "phase14b/go/main.go", language: "go", source });
  const extract = () => {
    const result = goFactExtractor.extract(input);
    assert.equal(result.kind, "facts");
    if (result.kind !== "facts") throw new Error("Go extraction failed");
    return result.facts;
  };
  const expected = extract();
  const receiverBindings = expected.bindingSeeds.filter(binding => binding.bindingKind === "receiver");
  assert.equal(receiverBindings.length, 6);
  assert.equal(expected.parameters.filter(parameter => parameter.receiverKind === "go_receiver").length, 6);
  assert.equal(expected.parameters.filter(parameter => parameter.name === "s" && parameter.receiverKind !== "go_receiver").length, 1);

  for (let run = 0; run < 16; run++) {
    const actual = extract();
    assert.deepEqual(actual, expected, `Go extraction drift on repetition ${run + 1}`);
  }
});
