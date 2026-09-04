import { createCliCommandReporter } from "./cli-command-reporter.js";
import { warmupEmbedding } from "../../infrastructure/embedding/transformers-embedding.client.js";
import { warmupReranker } from "../../infrastructure/reranker/transformers-reranker.client.js";
import { createDefaultProviders } from "../../infrastructure/provider-defaults.js";
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
  const reporter = createCliCommandReporter();
  const providers = createDefaultProviders(process.cwd());
  reporter.start("CodeAtlas Ask");
  reporter.start("Loading embedding model...");
  const embeddingStart = performance.now();

  await warmupEmbedding();
  reporter.success(
    `Embedding model loaded in ${((performance.now() - embeddingStart) / 1000).toFixed(2)}s`,
  );

  reporter.start("Loading reranker model...");
  const rerankerLoadStart = performance.now();

  await warmupReranker();
  reporter.success(
    `Reranker model loaded in ${((performance.now() - rerankerLoadStart) / 1000).toFixed(2)}s`,
  );

  let streamStarted = false;

  let result;

  try {
    result = await answerCodebase(
      question,
      {
        providers,
        onInspection(inspection) {
          reporter.success(
            `Inspected ${inspection.rerankedResults.length} reranked chunks and ${inspection.graphExpansion.nodesAdded} graph nodes`,
          );

          reporter.detail("\nTop reranked chunks:");

          for (const chunk of inspection.rerankedResults) {
            reporter.detail(formatRerankedChunk(chunk));
          }

          reporter.detail(
            `\nContext: ${inspection.finalContext.chunks.length}/${inspection.rerankedResults.length + inspection.graphExpansion.nodesAdded} chunks, ${inspection.finalContext.tokens} tokens`,
          );

          reporter.start("Waiting for llama.cpp...");
        },
      },
      {
        onToken(token) {
          if (!streamStarted) {
            process.stdout.write("\n");
            streamStarted = true;
          }

          process.stdout.write(token);
        },
      },
    );
  } catch (error) {
    reporter.failure("Generation failed");
    throw error;
  }

  if (!streamStarted) reporter.warning("Generation returned no streamed tokens");

  process.stdout.write("\n");
  reporter.success("Generation complete");

  const totalDuration = performance.now() - totalStart;

  reporter.detail("\n---");
  reporter.detail(`Search: ${(result.metrics.searchMs / 1000).toFixed(2)}s`);
  reporter.detail(`Rerank: ${(result.metrics.rerankMs / 1000).toFixed(2)}s`);
  reporter.detail(
    `Graph expansion: ${(result.metrics.graphExpansionMs / 1000).toFixed(4)}s`,
  );
  reporter.detail(`Graph nodes added: ${result.graphExpansion.nodesAdded}`);
  reporter.detail(`Context build: ${(result.metrics.contextMs / 1000).toFixed(4)}s`);
  reporter.detail(
    `Context chunks: ${result.finalContext.chunks.length}/${result.rerankedResults.length + result.graphExpansion.nodesAdded}`,
  );
  reporter.detail(`Context tokens: ${result.finalContext.tokens}`);
  reporter.detail(
    `TTFT: ${result.metrics.ttftMs === null ? "N/A" : `${(result.metrics.ttftMs / 1000).toFixed(2)}s`}`,
  );
  reporter.detail(`Generation: ${(result.metrics.generationMs / 1000).toFixed(2)}s`);
  reporter.detail(`Total: ${(totalDuration / 1000).toFixed(2)}s`);
}

function formatRerankedChunk(chunk: InspectorChunk): string {
  return [
    `  ${chunk.file}:${chunk.startLine}-${chunk.endLine}`,
    `    ${chunk.symbolName} (${chunk.symbolType}) · rerank ${chunk.rerankScore?.toFixed(4) ?? "-"} · fusion ${chunk.fusionScore?.toFixed(6) ?? "-"} · vector ${chunk.vectorScore?.toFixed(4) ?? "-"} · lexical ${chunk.lexicalScore?.toFixed(2) ?? "-"}`,
  ].join("\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
