import ora from "ora";

import { warmupEmbedding } from "../../infrastructure/embedding/transformers-embedding.client.js";
import { warmupReranker } from "../../infrastructure/reranker/transformers-reranker.client.js";
import { defaultProviders } from "../../infrastructure/provider-defaults.js";
import {
  answerCodebase,
  type InspectorChunk,
} from "../../core/retrieval/retrieval-inspector.service.js";

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ");

  if (!question) {
    throw new Error('Usage: pnpm exec tsx src/adapters/cli/ask-rag.command.ts "your question"');
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

  let generationSpinner: ReturnType<typeof ora> | undefined;
  let streamStarted = false;

  let result;

  try {
    result = await answerCodebase(
      question,
      {
        providers: defaultProviders,
        onInspection(inspection) {
          spinner = ora("Inspecting retrieval pipeline...").start();
          spinner.succeed(
            `Inspected ${inspection.rerankedResults.length} reranked chunks and ${inspection.graphExpansion.nodesAdded} graph nodes`,
          );

          console.log("\nTop reranked chunks:");

          for (const chunk of inspection.rerankedResults) {
            printRerankedChunk(chunk);
          }

          console.log(
            `\nContext: ${inspection.finalContext.chunks.length}/${inspection.rerankedResults.length + inspection.graphExpansion.nodesAdded} chunks, ${inspection.finalContext.tokens} tokens`,
          );

          generationSpinner = ora("Waiting for llama.cpp...").start();
        },
      },
      {
        onToken(token) {
          if (!streamStarted) {
            generationSpinner?.stop();
            process.stdout.write("\n");
            streamStarted = true;
          }

          process.stdout.write(token);
        },
      },
    );
  } catch (error) {
    generationSpinner?.fail("Generation failed");
    throw error;
  }

  if (!streamStarted) {
    generationSpinner?.stop();
  }

  process.stdout.write("\n");

  const totalDuration = performance.now() - totalStart;

  console.log("\n---");
  console.log(`Search: ${(result.metrics.searchMs / 1000).toFixed(2)}s`);
  console.log(`Rerank: ${(result.metrics.rerankMs / 1000).toFixed(2)}s`);
  console.log(
    `Graph expansion: ${(result.metrics.graphExpansionMs / 1000).toFixed(4)}s`,
  );
  console.log(`Graph nodes added: ${result.graphExpansion.nodesAdded}`);
  console.log(`Context build: ${(result.metrics.contextMs / 1000).toFixed(4)}s`);
  console.log(
    `Context chunks: ${result.finalContext.chunks.length}/${result.rerankedResults.length + result.graphExpansion.nodesAdded}`,
  );
  console.log(`Context tokens: ${result.finalContext.tokens}`);
  console.log(
    `TTFT: ${result.metrics.ttftMs === null ? "N/A" : `${(result.metrics.ttftMs / 1000).toFixed(2)}s`}`,
  );
  console.log(`Generation: ${(result.metrics.generationMs / 1000).toFixed(2)}s`);
  console.log(`Total: ${(totalDuration / 1000).toFixed(2)}s`);
}

function printRerankedChunk(chunk: InspectorChunk): void {
  console.log({
    rerankScore: chunk.rerankScore?.toFixed(4) ?? "-",
    fusionScore: chunk.fusionScore?.toFixed(6) ?? "-",
    vectorScore: chunk.vectorScore?.toFixed(4) ?? "-",
    lexicalScore: chunk.lexicalScore?.toFixed(2) ?? "-",
    file: chunk.file,
    symbol: chunk.symbolName,
    type: chunk.symbolType,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
