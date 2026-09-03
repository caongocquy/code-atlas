import { loadEnvFile } from "node:process";

loadEnvFile();

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type StreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
    };
    finish_reason?: string | null;
  }>;
};

const LLAMA_BASE_URL =
  process.env.LLAMA_BASE_URL ?? "http://100.78.8.38:8080/v1";

const LLAMA_MODEL = process.env.LLAMA_MODEL ?? "qwen3.6-35b-256k";

const LLAMA_CPP_API_KEY = process.env.LLAMA_CPP_API_KEY;

export type StreamChatOptions = {
  onToken?: (token: string) => void;
  onReasoningToken?: (token: string) => void;
};

export type StreamChatResult = {
  content: string;
  reasoningContent: string;
  ttftMs: number | null;
  totalMs: number;
};

export async function chatStream(
  messages: ChatMessage[],
  options: StreamChatOptions = {},
): Promise<StreamChatResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (LLAMA_CPP_API_KEY) {
    headers.Authorization = `Bearer ${LLAMA_CPP_API_KEY}`;
  }

  const requestStart = performance.now();

  const response = await fetch(`${LLAMA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: LLAMA_MODEL,
      messages,
      temperature: 0.1,
      max_tokens: 8192,
      stream: true,
      chat_template_kwargs: {
        enable_thinking: false,
      },
    }),
    signal: AbortSignal.timeout(900_000),
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(`llama.cpp request failed: ${response.status} ${body}`);
  }

  if (!response.body) {
    throw new Error("llama.cpp returned no response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let ttftMs: number | null = null;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, {
      stream: true,
    });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line.startsWith("data:")) {
        continue;
      }

      const data = line.slice(5).trim();

      if (!data || data === "[DONE]") {
        continue;
      }

      let chunk: StreamChunk;

      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta;

      const reasoningToken = delta?.reasoning_content ?? "";

      if (reasoningToken) {
        reasoningContent += reasoningToken;

        options.onReasoningToken?.(reasoningToken);
      }

      const token = delta?.content ?? "";

      if (!token) {
        continue;
      }

      if (ttftMs === null) {
        ttftMs = performance.now() - requestStart;
      }

      content += token;

      options.onToken?.(token);
    }
  }

  return {
    content: content.trim(),
    reasoningContent: reasoningContent.trim(),
    ttftMs,
    totalMs: performance.now() - requestStart,
  };
}
