import { AutoTokenizer } from "@huggingface/transformers";

import { EMBEDDING_MODEL } from "../config/constants.js";

const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_MODEL);

export function countTokens(text: string): number {
  const encoded = tokenizer(text);

  return encoded.input_ids.size;
}
