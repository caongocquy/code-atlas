import type { ChatMessage } from "../lib/llama.js";

export function buildCodebaseMessages(
  question: string,
  context: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a coding assistant.",
        "Answer only using the provided repository context.",
        "If the context is insufficient, say so clearly.",
        "Always mention relevant file paths and symbols when possible.",
        "Do not invent code that is not present in the context.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Question:\n${question}`,
        "",
        "Repository context:",
        context,
      ].join("\n"),
    },
  ];
}
