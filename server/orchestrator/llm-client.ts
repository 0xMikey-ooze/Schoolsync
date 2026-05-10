import Anthropic from "@anthropic-ai/sdk";

/**
 * Minimal LLM contract used by the Schoolsync processing pipeline.
 *
 * The real production implementation calls claude-sonnet-4-6 via the official
 * Anthropic SDK. The interface is intentionally small (one method, JSON-string
 * in -> JSON-string out) so the pipeline can be unit-tested with a stubbed
 * client and so that we never grow a second AI client library here.
 */
export interface LLMClient {
  /**
   * Sends `system` + `user` prompts to the model and returns the raw text body
   * of the assistant's response (expected to be a JSON object string).
   */
  complete(args: { system: string; user: string }): Promise<string>;
}

export const SCHOOLSYNC_MODEL = "claude-sonnet-4-6" as const;

export interface AnthropicClientOptions {
  /** Override for tests; defaults to ANTHROPIC_API_KEY from the environment. */
  apiKey?: string;
  /** Overall request budget. Defaults to 30s; matches LLM-call timeout lesson. */
  timeoutMs?: number;
  /** Cap on response length; the structured output is small, 4k tokens is plenty. */
  maxTokens?: number;
}

/**
 * Build a real Anthropic-backed LLMClient. Throws synchronously if no API key
 * is available so the caller can fall back or mark a test skipped early.
 */
export function createAnthropicLLMClient(
  opts: AnthropicClientOptions = {},
): LLMClient {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set; cannot construct LLM client for Schoolsync processing.",
    );
  }
  const client = new Anthropic({
    apiKey,
    timeout: opts.timeoutMs ?? 30_000,
  });
  const maxTokens = opts.maxTokens ?? 4096;

  return {
    async complete({ system, user }) {
      const response = await client.messages.create({
        model: SCHOOLSYNC_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      });
      // Concatenate any text blocks; tool-use blocks are not used for this
      // pipeline because the prompt locks the model into raw JSON output.
      return response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
    },
  };
}
