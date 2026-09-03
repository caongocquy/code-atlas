import ora from "ora";

import { warmupEmbedding } from "./lib/embedding.js";
import { chatStream } from "./lib/llama.js";
import { warmupReranker } from "./lib/reranker.js";
import { inspectRetrieval } from "./services/retrieval-inspector.js";

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ");

  if (!question) {
    throw new Error('Usage: pnpm exec tsx src/ask-rag.ts "your question"');
  }

  const totalStart = performance.now();
  let spinner = ora("Loading embedding model...").start();
  const embeddingStart = performance.now();

  await warmupEmbedding();
  spinner.succeed(
    `Embedding model loaded in ${((performance.now() - embeddingStart) / 1000).toFixed(2)}s`,
  );

  spinner = ora("Loading reranker model...").start();
  const rerankerLoadStart = performance.now();

  await warmupReranker();
  spinner.succeed(
    `Reranker model loaded in ${((performance.now() - rerankerLoadStart) / 1000).toFixed(2)}s`,
  );

  spinner = ora("Inspecting retrieval pipeline...").start();
  const inspection = await inspectRetrieval(question);
  spinner.succeed(
    `Inspected ${inspection.rerankedResults.length} reranked chunks and ${inspection.graphExpansion.nodesAdded} graph nodes`,
  );

  console.log("\nTop reranked chunks:");

  for (const result of inspection.rerankedResults) {
    console.log({
      rerankScore: result.rerankScore?.toFixed(4) ?? "-",
      fusionScore: result.fusionScore?.toFixed(6) ?? "-",
      vectorScore: result.vectorScore?.toFixed(4) ?? "-",
      lexicalScore: result.lexicalScore?.toFixed(2) ?? "-",
      file: result.file,
      symbol: result.symbolName,
      type: result.symbolType,
    });
  }

  console.log(
    `\nContext: ${inspection.finalContext.chunks.length}/${inspection.rerankedResults.length + inspection.graphExpansion.nodesAdded} chunks, ${inspection.finalContext.tokens} tokens`,
  );

  const generationSpinner = ora("Waiting for llama.cpp...").start();
  let streamStarted = false;

  try {
    const result = await chatStream(inspection.messages, {
      onToken(token) {
        if (!streamStarted) {
          generationSpinner.stop();
          process.stdout.write("\n");
          streamStarted = true;
        }

        process.stdout.write(token);
      },
    });

    if (!streamStarted) {
      generationSpinner.stop();
    }

    process.stdout.write("\n");

    const totalDuration = performance.now() - totalStart;

    console.log("\n---");
    console.log(`Search: ${(inspection.metrics.searchMs / 1000).toFixed(2)}s`);
    console.log(`Rerank: ${(inspection.metrics.rerankMs / 1000).toFixed(2)}s`);
    console.log(
      `Graph expansion: ${(inspection.metrics.graphExpansionMs / 1000).toFixed(4)}s`,
    );
    console.log(`Graph nodes added: ${inspection.graphExpansion.nodesAdded}`);
    console.log(`Context build: ${(inspection.metrics.contextMs / 1000).toFixed(4)}s`);
    console.log(
      `Context chunks: ${inspection.finalContext.chunks.length}/${inspection.rerankedResults.length + inspection.graphExpansion.nodesAdded}`,
    );
    console.log(`Context tokens: ${inspection.finalContext.tokens}`);
    console.log(
      `TTFT: ${result.ttftMs === null ? "N/A" : `${(result.ttftMs / 1000).toFixed(2)}s`}`,
    );
    console.log(`Generation: ${(result.totalMs / 1000).toFixed(2)}s`);
    console.log(`Total: ${(totalDuration / 1000).toFixed(2)}s`);
  } catch (error) {
    generationSpinner.fail("Generation failed");

    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
