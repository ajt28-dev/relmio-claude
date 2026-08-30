import { randomBytes } from "node:crypto";

export function createChatCompletionId(random = randomBytes) {
  return `chatcmpl_${random(16).toString("hex")}`;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Map the provider's Claude-shaped usage block onto OpenAI's usage fields.
// Claude reports input_tokens exclusive of cached tokens, so the OpenAI
// prompt_tokens value is the sum of fresh, cache-write, and cache-read input
// tokens. When the provider reports no usable numbers, usage is omitted
// entirely rather than fabricated.
export function mapUsage(providerUsage) {
  if (providerUsage === null || typeof providerUsage !== "object") {
    return null;
  }
  const input = nonNegativeInteger(providerUsage.input_tokens);
  const output = nonNegativeInteger(providerUsage.output_tokens);
  if (input === null || output === null) {
    return null;
  }
  const promptTokens =
    input +
    (nonNegativeInteger(providerUsage.cache_creation_input_tokens) ?? 0) +
    (nonNegativeInteger(providerUsage.cache_read_input_tokens) ?? 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: promptTokens + output,
  };
}

// Build an OpenAI chat.completion response from a provider result. The model
// field reports the model Claude actually served when the provider observed
// one (mirroring how OpenAI returns resolved snapshot IDs); the relay alias
// is the fallback, never a false claim about a specific upstream model.
//
// For a tool-call turn the assistant message carries `content: null` - never
// an empty array, which breaks OpenAI-compatible agent stacks - alongside
// the tool_calls list, and finish_reason becomes "tool_calls".
export function createChatCompletionResponse({
  relayModel,
  providerResult,
  toolCalls = null,
  id = createChatCompletionId(),
  created = Math.floor(Date.now() / 1000),
}) {
  const usage = mapUsage(providerResult.usage);
  return {
    id,
    object: "chat.completion",
    created,
    model:
      typeof providerResult.model === "string" && providerResult.model !== ""
        ? providerResult.model
        : relayModel,
    choices: [
      {
        index: 0,
        message:
          toolCalls === null
            ? { role: "assistant", content: providerResult.text }
            : { role: "assistant", content: null, tool_calls: toolCalls },
        finish_reason: toolCalls === null ? "stop" : "tool_calls",
      },
    ],
    ...(usage === null ? {} : { usage }),
  };
}
