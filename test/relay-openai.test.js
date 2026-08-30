import assert from "node:assert/strict";
import test from "node:test";

import { loadRelayConfig } from "../src/relay/config.js";
import { RelayHttpError, mapProviderError } from "../src/relay/errors.js";
import { listRelayModels, resolveRelayModel } from "../src/relay/models.js";
import { translateChatCompletionRequest } from "../src/relay/openai/messages.js";
import {
  createChatCompletionId,
  createChatCompletionResponse,
  mapUsage,
} from "../src/relay/openai/completions.js";

const FAKE_TOKEN = "sk-ant-oat01-FAKE-relay-test-token-0123456789";

function baseEnvironment(overrides = {}) {
  return { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, ...overrides };
}

test("loadRelayConfig applies loopback defaults and validates overrides", () => {
  const config = loadRelayConfig(baseEnvironment());
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 10_532);
  assert.equal(config.hasRelayAuth, false);
  assert.equal(config.apiKeyVerifier, null);

  const custom = loadRelayConfig(
    baseEnvironment({
      CLAUDE_RELAY_HOST: "localhost",
      CLAUDE_RELAY_PORT: "0",
      CLAUDE_RELAY_API_KEY: "relay-test-key-123",
    }),
  );
  assert.equal(custom.host, "localhost");
  assert.equal(custom.port, 0);
  assert.equal(custom.hasRelayAuth, true);
  assert.equal(Buffer.isBuffer(custom.apiKeyVerifier), true);
  // The raw relay key must not be stored on the config object.
  assert.equal(
    JSON.stringify(config).includes("relay-test-key-123"),
    false,
  );

  assert.throws(
    () => loadRelayConfig(baseEnvironment({ CLAUDE_RELAY_PORT: "99999" })),
    /CLAUDE_RELAY_PORT/u,
  );
  assert.throws(
    () => loadRelayConfig(baseEnvironment({ CLAUDE_RELAY_HOST: "example.com" })),
    /CLAUDE_RELAY_HOST/u,
  );
  assert.throws(
    () => loadRelayConfig(baseEnvironment({ CLAUDE_RELAY_API_KEY: "short" })),
    /CLAUDE_RELAY_API_KEY/u,
  );
});

test("loadRelayConfig fails fast without the Claude credential", () => {
  assert.throws(
    () => loadRelayConfig({}),
    (error) =>
      error.code === "relay_config" &&
      /CLAUDE_CODE_OAUTH_TOKEN/u.test(error.message) &&
      /claude setup-token/u.test(error.message),
  );
});

test("the models endpoint data lists only the relay default model", () => {
  assert.deepEqual(listRelayModels(), {
    object: "list",
    data: [
      { id: "claude-relay-default", object: "model", owned_by: "claude-relay" },
    ],
  });
  assert.equal(resolveRelayModel("claude-relay-default").providerModel, undefined);
  assert.throws(
    () => resolveRelayModel("gpt-4o"),
    (error) => error.status === 400 && error.code === "model_not_found",
  );
  assert.throws(
    () => resolveRelayModel(""),
    (error) => error.status === 400 && error.code === "model_required",
  );
});

test("translation passes a single user message through untouched", () => {
  const { prompt, systemPrompt } = translateChatCompletionRequest({
    model: "claude-relay-default",
    messages: [{ role: "user", content: "Reply exactly with CLAUDE RELAY HTTP WORKS" }],
  });
  assert.equal(prompt, "Reply exactly with CLAUDE RELAY HTTP WORKS");
  assert.equal(systemPrompt, undefined);
});

test("translation renders system + multi-turn history in order", () => {
  const { prompt, systemPrompt } = translateChatCompletionRequest({
    model: "claude-relay-default",
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "My name is Anna." },
      { role: "assistant", content: "Hello Anna." },
      { role: "system", content: "Never use emoji." },
      { role: "user", content: "What is my name?" },
    ],
  });

  assert.equal(systemPrompt, "You are terse.\n\nNever use emoji.");
  const historyStart = prompt.indexOf("<conversation-history>");
  const userTurn = prompt.indexOf("User: My name is Anna.");
  const assistantTurn = prompt.indexOf("Assistant: Hello Anna.");
  const historyEnd = prompt.indexOf("</conversation-history>");
  const latest = prompt.indexOf("User: What is my name?");
  assert.ok(historyStart >= 0);
  assert.ok(userTurn > historyStart);
  assert.ok(assistantTurn > userTurn);
  assert.ok(historyEnd > assistantTurn);
  assert.ok(latest > historyEnd, "latest message must follow the history block");
});

test("translation rejects unsupported features explicitly", () => {
  const valid = [{ role: "user", content: "hi" }];
  const cases = [
    [{ messages: valid, stream: true }, "streaming_not_supported", "stream"],
    [
      { messages: valid, stream_options: { include_usage: true } },
      "streaming_not_supported",
      "stream_options",
    ],
    [
      { messages: valid, functions: [{ name: "f" }] },
      "legacy_functions_not_supported",
      "functions",
    ],
    [
      { messages: valid, function_call: "auto" },
      "legacy_functions_not_supported",
      "function_call",
    ],
    [
      { messages: valid, response_format: { type: "json_object" } },
      "structured_output_not_supported",
      "response_format",
    ],
    [{ messages: valid, n: 2 }, "multiple_choices_not_supported", "n"],
    [
      { messages: [{ role: "tool", content: "result" }] },
      "invalid_tool_result",
      "messages[0].tool_call_id",
    ],
    [
      {
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1" }],
          },
          { role: "user", content: "hi" },
        ],
      },
      "invalid_tool_calls",
      "messages[0].tool_calls[0].type",
    ],
    [
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      "multimodal_not_supported",
      "messages[0].content",
    ],
  ];

  for (const [body, code, param] of cases) {
    assert.throws(
      () => translateChatCompletionRequest(body),
      (error) =>
        error instanceof RelayHttpError &&
        error.status === 400 &&
        error.code === code &&
        error.param === param,
      `expected ${code} for ${JSON.stringify(body).slice(0, 80)}`,
    );
  }
});

test("translation tolerates empty tool arrays and stream: false", () => {
  const { prompt } = translateChatCompletionRequest({
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    tools: [],
    functions: [],
    n: 1,
    temperature: 0.7,
    max_tokens: 512,
  });
  assert.equal(prompt, "hi");
});

test("translation validates message structure", () => {
  const cases = [
    [{}, "invalid_messages"],
    [{ messages: [] }, "invalid_messages"],
    [{ messages: [{ role: "developer", content: "x" }] }, "invalid_role"],
    [{ messages: [{ role: "user", content: 5 }] }, "invalid_content"],
    [{ messages: [{ role: "system", content: "only system" }] }, "invalid_messages"],
    [
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
      "assistant_prefill_not_supported",
    ],
    [{ messages: [{ role: "user", content: "" }] }, "invalid_messages"],
  ];
  for (const [body, code] of cases) {
    assert.throws(
      () => translateChatCompletionRequest(body),
      (error) => error.status === 400 && error.code === code,
      `expected ${code}`,
    );
  }
});

test("completion responses follow the OpenAI shape and report the served model", () => {
  const response = createChatCompletionResponse({
    relayModel: "claude-relay-default",
    providerResult: {
      text: "CLAUDE RELAY HTTP WORKS",
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
      },
    },
    id: "chatcmpl_test",
    created: 1_234_567_890,
  });

  assert.deepEqual(response, {
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 1_234_567_890,
    model: "claude-sonnet-5",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "CLAUDE RELAY HTTP WORKS" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
  });
});

test("usage is omitted rather than fabricated and ids look right", () => {
  const response = createChatCompletionResponse({
    relayModel: "claude-relay-default",
    providerResult: { text: "hi", model: null, usage: null },
    id: "chatcmpl_test",
    created: 1,
  });
  assert.equal(response.usage, undefined);
  assert.equal(response.model, "claude-relay-default");
  assert.equal(mapUsage({ input_tokens: 1 }), null);
  assert.match(createChatCompletionId(), /^chatcmpl_[a-f0-9]{32}$/u);
});

test("provider errors map to stable HTTP statuses", () => {
  const cases = [
    [{ code: "missing_claude_token", message: "x" }, 503, "provider_not_configured"],
    [{ code: "claude_sdk_unavailable", message: "x" }, 503, "provider_not_configured"],
    [{ code: "claude_timeout", message: "x" }, 504, "provider_timeout"],
    [{ code: "claude_result_error", message: "subtype" }, 502, "provider_error"],
    [{ code: "claude_query_failed", message: "boom" }, 502, "provider_error"],
    [{ code: "claude_protocol", message: "x" }, 502, "provider_error"],
    [new TypeError("internal"), 500, "relay_error"],
    [
      { code: "claude_query_failed", message: "Claude usage limit reached" },
      429,
      "provider_rate_limited",
    ],
    [
      { code: "claude_result_error", message: "rate limit hit, retry later" },
      429,
      "provider_rate_limited",
    ],
  ];
  for (const [providerError, status, code] of cases) {
    const mapped = mapProviderError(providerError);
    assert.equal(mapped.status, status, `status for ${providerError.code}`);
    assert.equal(mapped.code, code, `code for ${providerError.code}`);
  }
});

test("mapped provider errors truncate long detail and keep redactions", () => {
  const mapped = mapProviderError({
    code: "claude_query_failed",
    message: `The Claude session failed: [redacted] ${"x".repeat(600)}`,
  });
  assert.ok(mapped.message.length < 300);
  assert.ok(!mapped.message.includes(FAKE_TOKEN));
});
