import assert from "node:assert/strict";
import test from "node:test";

import { parseSource } from "../src/core/graph/parsers/code-parser.js";
import { getLanguageConfig } from "../src/core/graph/parsers/languages.js";
import { parserFixtures } from "./helpers/phase14b-language-fixtures.js";

test("all target grammars load through the native parser runtime with exact package identity", () => {
  for (const fixture of Object.values(parserFixtures)) {
    for (const item of fixture.cases) {
      const parsed = parseSource(item.source, item.filePath);
      assert.ok(parsed, item.filePath);
      assert.equal(parsed.adapter.language, item.language);
      assert.equal(parsed.tree.rootNode.hasError, false, item.filePath);
      assert.equal(parsed.adapter.metadata.runtimeName, "tree-sitter");
      assert.ok(parsed.adapter.metadata.packageName.length > 0);
    }
  }
  assert.equal(getLanguageConfig("lib/main.dart")?.metadata.packageName, "@driftlog/tree-sitter-dart");
});
