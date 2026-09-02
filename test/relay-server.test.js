import assert from "node:assert/strict";
import test from "node:test";

import { loadRelayConfig } from "../src/relay/config.js";
import { createRelayServer, startRelayServer } from "../src/relay/server.js";

const FAKE_TOKEN = "sk-ant-oat01-FAKE-relay-server-token-0123456789";
const RELAY_KEY = "relay-test-key-123";

function fakeProviderResult(overrides = {}) {
  return {
    text: "CLAUDE RELAY HTTP WORKS",
    model: "claude-sonnet-5",
    usage: { input_tokens: 10, output_tokens: 5 },
    structuredOutput: null,
    subtype: "success",
    ...overrides,
  };
}

async function withRelay(t, { environment = {}, provider, ...options } = {}) {
  const capture = { calls: [] };
  const queryProvider =
    provider ??
    (async (request, dependencies) => {
      capture.calls.push({ request, dependencies });
      return fakeProviderResult();
    });
  const config = loadRelayConfig({
    CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
    CLAUDE_RELAY_PORT: "0",
    CLAUDE_RELAY_API_KEY: RELAY_KEY,
    ...environment,
  });
  const server = createRelayServer({ config, queryProvider, ...options });
  await new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(
    () =>
      new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections?.();
      }),
  );
  return { origin, capture };
}

function chatBody(overrides = {}) {
  return JSON.stringify({
    model: "claude-relay-default",
    messages: [
      { role: "user", content: "Reply exactly with CLAUDE RELAY HTTP WORKS" },
    ],
    ...overrides,
  });
}

function authorizedHeaders(overrides = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${RELAY_KEY}`,
    ...overrides,
  };
}

test("GET /health is open, reports configuration, and leaks nothing", async (t) => {
  const { origin } = await withRelay(t);
  const response = await fetch(`${origin}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.provider, "claude");
  assert.equal(body.auth_mode, "subscription_oauth");
  assert.equal(body.relay_auth, "enabled");
  assert.equal(typeof body.relay_version, "string");
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(FAKE_TOKEN));
  assert.ok(!raw.includes(RELAY_KEY));
});

test("GET /v1/models requires and accepts the relay key", async (t) => {
  const { origin } = await withRelay(t);

  const missing = await fetch(`${origin}/v1/models`);
  assert.equal(missing.status, 401);
  const missingBody = await missing.json();
  assert.equal(missingBody.error.type, "authentication_error");
  assert.ok(!JSON.stringify(missingBody).includes(RELAY_KEY));

  const wrong = await fetch(`${origin}/v1/models`, {
    headers: { Authorization: "Bearer wrong-key-000000" },
  });
  assert.equal(wrong.status, 401);

  const ok = await fetch(`${origin}/v1/models`, {
    headers: { Authorization: `Bearer ${RELAY_KEY}` },
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.object, "list");
  assert.deepEqual(body.data, [
    { id: "claude-relay-default", object: "model", owned_by: "claude-relay" },
  ]);
});

test("relay auth is disabled when no key is configured", async (t) => {
  const { origin } = await withRelay(t, {
    environment: { CLAUDE_RELAY_API_KEY: "" },
  });
  const response = await fetch(`${origin}/v1/models`);
  assert.equal(response.status, 200);
  const health = await (await fetch(`${origin}/health`)).json();
  assert.equal(health.relay_auth, "disabled");
});

test("POST /v1/chat/completions returns an OpenAI completion", async (t) => {
  const { origin, capture } = await withRelay(t);
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: chatBody(),
  });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.match(body.id, /^chatcmpl_[a-f0-9]{32}$/u);
  assert.equal(body.object, "chat.completion");
  assert.equal(Number.isSafeInteger(body.created), true);
  assert.equal(body.model, "claude-sonnet-5");
  assert.equal(body.choices.length, 1);
  assert.equal(body.choices[0].index, 0);
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].message.content, "CLAUDE RELAY HTTP WORKS");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.deepEqual(body.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });

  // Provider invocation: translated prompt, relay environment, default model.
  assert.equal(capture.calls.length, 1);
  const { request, dependencies } = capture.calls[0];
  assert.equal(request.prompt, "Reply exactly with CLAUDE RELAY HTTP WORKS");
  assert.equal(request.systemPrompt, undefined);
  assert.equal(request.model, undefined);
  assert.equal(
    dependencies.environment.CLAUDE_CODE_OAUTH_TOKEN,
    FAKE_TOKEN,
  );
});

test("system and history messages reach the provider translated", async (t) => {
  const { origin, capture } = await withRelay(t);
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: JSON.stringify({
      model: "claude-relay-default",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "My name is Anna." },
        { role: "assistant", content: "Hello Anna." },
        { role: "user", content: "What is my name?" },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const { request } = capture.calls[0];
  assert.equal(request.systemPrompt, "You are terse.");
  assert.ok(request.prompt.includes("User: My name is Anna."));
  assert.ok(request.prompt.includes("Assistant: Hello Anna."));
  assert.ok(request.prompt.includes("User: What is my name?"));
});

test("request validation returns OpenAI-shaped errors", async (t) => {
  const { origin, capture } = await withRelay(t);
  const post = (body, headers = authorizedHeaders()) =>
    fetch(`${origin}/v1/chat/completions`, { method: "POST", headers, body });

  const cases = [
    [chatBody({ model: undefined }), 400, "model_required"],
    [chatBody({ model: "gpt-4o" }), 400, "model_not_found"],
    [chatBody({ messages: undefined }), 400, "invalid_messages"],
    [chatBody({ messages: [] }), 400, "invalid_messages"],
    [
      chatBody({ messages: [{ role: "developer", content: "x" }] }),
      400,
      "invalid_role",
    ],
    [chatBody({ stream: true }), 400, "streaming_not_supported"],
    [chatBody({ tools: [{ type: "function" }] }), 400, "invalid_tools"],
    [chatBody({ tool_choice: "required" }), 400, "invalid_tool_choice"],
    [
      chatBody({ response_format: { type: "json_object" } }),
      400,
      "structured_output_not_supported",
    ],
    [
      chatBody({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://x" } }],
          },
        ],
      }),
      400,
      "multimodal_not_supported",
    ],
    ["{not json", 400, "invalid_json"],
  ];

  for (const [body, status, code] of cases) {
    const response = await post(body);
    assert.equal(response.status, status, `status for ${code}`);
    const parsed = await response.json();
    assert.equal(parsed.error.code, code);
    assert.equal(parsed.error.type, "invalid_request_error");
    assert.equal(typeof parsed.error.message, "string");
  }
  assert.equal(capture.calls.length, 0, "provider must never be invoked");
});

test("oversized bodies are rejected with 413", async (t) => {
  const { origin, capture } = await withRelay(t, { maxBodyBytes: 2_048 });
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: chatBody({
      messages: [{ role: "user", content: "x".repeat(4_096) }],
    }),
  });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, "request_too_large");
  assert.equal(capture.calls.length, 0);
});

test("wrong content type, methods, unknown routes, and origins are rejected", async (t) => {
  const { origin } = await withRelay(t);

  const badType = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders({ "Content-Type": "text/plain" }),
    body: chatBody(),
  });
  assert.equal(badType.status, 415);

  const badMethod = await fetch(`${origin}/v1/chat/completions`, {
    headers: { Authorization: `Bearer ${RELAY_KEY}` },
  });
  assert.equal(badMethod.status, 405);

  const badModelsMethod = await fetch(`${origin}/v1/models`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: "{}",
  });
  assert.equal(badModelsMethod.status, 405);

  const unknown = await fetch(`${origin}/v1/unknown`, {
    headers: { Authorization: `Bearer ${RELAY_KEY}` },
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "unknown_endpoint");

  const withOrigin = await fetch(`${origin}/v1/models`, {
    headers: {
      Authorization: `Bearer ${RELAY_KEY}`,
      Origin: "https://evil.example",
    },
  });
  assert.equal(withOrigin.status, 403);
});

test("provider failures map to stable HTTP statuses", async (t) => {
  const failures = [
    [{ code: "claude_timeout" }, 504, "provider_timeout"],
    [{ code: "claude_result_error", message: "error_max_turns" }, 502, "provider_error"],
    [{ code: "missing_claude_token", message: "x" }, 503, "provider_not_configured"],
    [
      { code: "claude_query_failed", message: "usage limit reached" },
      429,
      "provider_rate_limited",
    ],
  ];

  for (const [providerError, status, code] of failures) {
    const { origin } = await withRelay(t, {
      provider: async () => {
        throw Object.assign(new Error(providerError.message ?? "failed"), {
          code: providerError.code,
        });
      },
    });
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: authorizedHeaders(),
      body: chatBody(),
    });
    assert.equal(response.status, status, `status for ${providerError.code}`);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.ok(!JSON.stringify(body).includes(FAKE_TOKEN));
  }
});

test("concurrent completions beyond the limit are rejected with 429", async (t) => {
  let release;
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const { origin } = await withRelay(t, {
    maxConcurrentRequests: 1,
    provider: async () => {
      await gate;
      return fakeProviderResult();
    },
  });

  const first = fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: chatBody(),
  });
  // Give the first request time to enter the provider call.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  const second = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: chatBody(),
  });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "relay_overloaded");

  release();
  assert.equal((await first).status, 200);
});

// ---------------------------------------------------------------------------
// Tool calling over HTTP
// ---------------------------------------------------------------------------

const MULTIPLY_TOOL = {
  type: "function",
  function: {
    name: "multiply_numbers",
    description: "Multiply two numbers.",
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
};

function toolDecisionProvider(structuredOutput, capture = { calls: [] }) {
  return Object.assign(
    async (request, dependencies) => {
      capture.calls.push({ request, dependencies });
      return fakeProviderResult({ structuredOutput, text: "" });
    },
    { capture },
  );
}

test("a tool-enabled request returns OpenAI tool_calls", async (t) => {
  const provider = toolDecisionProvider({
    type: "tool_calls",
    calls: [
      { name: "multiply_numbers", arguments: { a: 23, b: 17 } },
      { name: "multiply_numbers", arguments: { a: 2, b: 3 } },
    ],
  });
  const { origin } = await withRelay(t, { provider });
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: chatBody({ tools: [MULTIPLY_TOOL] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const message = body.choices[0].message;

  assert.equal(body.choices[0].finish_reason, "tool_calls");
  // n8n compatibility regression: content must be null, never [].
  assert.equal(message.content, null);
  assert.equal(Array.isArray(message.content), false);
  assert.equal(message.tool_calls.length, 2);
  const [first, second] = message.tool_calls;
  assert.match(first.id, /^call_[a-f0-9]{24}$/u);
  assert.notEqual(first.id, second.id);
  assert.equal(first.type, "function");
  assert.equal(first.function.name, "multiply_numbers");
  assert.equal(typeof first.function.arguments, "string");
  assert.deepEqual(JSON.parse(first.function.arguments), { a: 23, b: 17 });

  // The provider saw structured-output mode with the decision schema, and
  // the request carried no executable tool definitions.
  const { request } = provider.capture.calls[0];
  assert.deepEqual(
    Object.keys(request).sort(),
    ["model", "outputFormat", "prompt", "systemPrompt"],
  );
  assert.equal(request.outputFormat.type, "json_schema");
  assert.equal(request.outputFormat.schema.type, "object");
  assert.equal(request.outputFormat.schema.oneOf, undefined);
  assert.deepEqual(request.outputFormat.schema.properties.type.enum, [
    "final",
    "tool_calls",
  ]);
  assert.ok(request.systemPrompt.includes("Function: multiply_numbers"));
});

test("a structured final decision returns a normal completion", async (t) => {
  const provider = toolDecisionProvider({
    type: "final",
    content: "The answer is 391.",
  });
  const { origin } = await withRelay(t, { provider });
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: chatBody({ tools: [MULTIPLY_TOOL] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.choices[0].message.content, "The answer is 391.");
  assert.equal(body.choices[0].message.tool_calls, undefined);
});

test("tool_choice modes shape the provider schema", async (t) => {
  const provider = toolDecisionProvider({ type: "final", content: "ok" });
  const { origin } = await withRelay(t, { provider });

  await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: chatBody({ tools: [MULTIPLY_TOOL], tool_choice: "none" }),
  });
  const noneSchema = provider.capture.calls[0].request.outputFormat.schema;
  assert.equal(noneSchema.properties.type.const, "final");

  const requiredProvider = toolDecisionProvider({
    type: "tool_calls",
    calls: [{ name: "multiply_numbers", arguments: { a: 1, b: 2 } }],
  });
  const { origin: origin2 } = await withRelay(t, { provider: requiredProvider });
  const response = await fetch(`${origin2}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: chatBody({
      tools: [MULTIPLY_TOOL],
      tool_choice: "required",
      parallel_tool_calls: false,
    }),
  });
  assert.equal((await response.json()).choices[0].finish_reason, "tool_calls");
  const requiredSchema =
    requiredProvider.capture.calls[0].request.outputFormat.schema;
  assert.equal(requiredSchema.properties.type.const, "tool_calls");
  assert.equal(requiredSchema.properties.calls.maxItems, 1);
});

test("a tool-result follow-up request reaches Claude as history", async (t) => {
  const provider = toolDecisionProvider({
    type: "final",
    content: "23 multiplied by 17 is 391.",
  });
  const { origin } = await withRelay(t, { provider });
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: JSON.stringify({
      model: "claude-relay-default",
      tools: [MULTIPLY_TOOL],
      messages: [
        { role: "user", content: "Use multiply_numbers to multiply 23 by 17." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc123",
              type: "function",
              function: {
                name: "multiply_numbers",
                arguments: '{"a":23,"b":17}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_abc123", content: "391" },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.match(body.choices[0].message.content, /391/u);

  const { request } = provider.capture.calls[0];
  assert.ok(
    request.prompt.includes(
      "Assistant tool call [id: call_abc123] [function: multiply_numbers]",
    ),
  );
  assert.ok(
    request.prompt.includes(
      "Tool result [id: call_abc123] [function: multiply_numbers]:\n391",
    ),
  );
});

test("tool decision failures surface as structured_output_failed", async (t) => {
  // structured_output missing despite tools.
  const nullProvider = toolDecisionProvider(null);
  const { origin } = await withRelay(t, { provider: nullProvider });
  const missing = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: chatBody({ tools: [MULTIPLY_TOOL] }),
  });
  assert.equal(missing.status, 502);
  assert.equal((await missing.json()).error.code, "structured_output_failed");

  // Provider-level retry exhaustion.
  const { origin: origin2 } = await withRelay(t, {
    provider: async () => {
      throw Object.assign(new Error("error_max_structured_output_retries"), {
        code: "claude_structured_output_failed",
      });
    },
  });
  const exhausted = await fetch(`${origin2}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: chatBody({ tools: [MULTIPLY_TOOL] }),
  });
  assert.equal(exhausted.status, 502);
  assert.equal((await exhausted.json()).error.code, "structured_output_failed");
});

test("n8n-style text-array content reaches the tool-decision path", async (t) => {
  // Regression fixture for the live n8n 2.36.7 AI Agent failure: LangChain
  // encodes plain text as OpenAI content-part arrays.
  const provider = toolDecisionProvider({
    type: "tool_calls",
    calls: [{ name: "multiply_numbers", arguments: { a: 1847, b: 392 } }],
  });
  const { origin } = await withRelay(t, { provider });
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: JSON.stringify({
      model: "claude-relay-default",
      tools: [MULTIPLY_TOOL],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What is 1847 multiplied by 392? Use the calculator tool.",
            },
          ],
        },
      ],
    }),
  });
  assert.equal(response.status, 200, "must not be rejected as multimodal");
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "tool_calls");

  const { request } = provider.capture.calls[0];
  assert.equal(
    request.prompt,
    "What is 1847 multiplied by 392? Use the calculator tool.",
  );
  // Still no executable tool definitions reach the provider.
  assert.deepEqual(
    Object.keys(request).sort(),
    ["model", "outputFormat", "prompt", "systemPrompt"],
  );
});

test("text-array follow-up loop with a text-array tool result completes", async (t) => {
  const provider = toolDecisionProvider({
    type: "final",
    content: "1847 multiplied by 392 is 724024.",
  });
  const { origin } = await withRelay(t, { provider });
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: JSON.stringify({
      model: "claude-relay-default",
      tools: [MULTIPLY_TOOL],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What is 1847 multiplied by 392?" }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_n8n1",
              type: "function",
              function: {
                name: "multiply_numbers",
                arguments: '{"a":1847,"b":392}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_n8n1",
          content: [{ type: "text", text: "724024" }],
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.match(body.choices[0].message.content, /724024/u);

  const { request } = provider.capture.calls[0];
  assert.ok(
    request.prompt.includes(
      "Tool result [id: call_n8n1] [function: multiply_numbers]:\n724024",
    ),
    "text-array tool result must flatten into the transcript",
  );
});

test("plain requests still bypass structured-output mode entirely", async (t) => {
  const { origin, capture } = await withRelay(t);
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authorizedHeaders(),
    body: chatBody(),
  });
  assert.equal(response.status, 200);
  const { request } = capture.calls[0];
  assert.equal(request.outputFormat, undefined);
  assert.deepEqual(
    Object.keys(request).sort(),
    ["model", "prompt", "systemPrompt"],
  );
});

test("startRelayServer binds the configured loopback host", async () => {
  const relay = await startRelayServer({
    environment: {
      CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
      CLAUDE_RELAY_PORT: "0",
    },
    queryProvider: async () => fakeProviderResult(),
  });
  try {
    assert.equal(relay.host, "127.0.0.1");
    assert.ok(relay.port > 0);
    const health = await fetch(`http://127.0.0.1:${relay.port}/health`);
    assert.equal(health.status, 200);
  } finally {
    await relay.close();
  }
});

// ---------------------------------------------------------------------------
// Live integration test. Requires a real subscription token and an explicit
// opt-in flag; spawns the bundled Claude Code binary through the full HTTP
// stack. Run with:
//   CLAUDE_CODE_OAUTH_TOKEN=... CLAUDE_RELAY_INTEGRATION_TEST=1 \
//     node --test test/relay-server.test.js
// ---------------------------------------------------------------------------

const liveToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const liveOptIn = process.env.CLAUDE_RELAY_INTEGRATION_TEST === "1";
const liveSkip =
  liveToken && liveOptIn
    ? false
    : "set CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_RELAY_INTEGRATION_TEST=1";

function redactSecrets(text, secrets) {
  let result = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      result = result.split(secret).join("[redacted]");
    }
  }
  return result;
}

// Live-test diagnostics: on a non-200 response, fail with only the HTTP
// status and the OpenAI error type/code plus a secret-redacted message.
// Never prints tokens, keys, headers, prompts, or tool arguments.
async function assertOkResponse(response, step) {
  if (response.status === 200) {
    return;
  }
  let detail = { status: response.status };
  try {
    const body = await response.json();
    if (body?.error) {
      detail = {
        status: response.status,
        type: body.error.type ?? null,
        code: body.error.code ?? null,
        message: redactSecrets(String(body.error.message ?? ""), [
          liveToken,
          "integration-relay-key",
        ]),
      };
    }
  } catch {
    // A non-JSON error body is reported by status alone.
  }
  assert.fail(`${step} returned a non-200 response: ${JSON.stringify(detail)}`);
}

test(
  "integration: full HTTP relay round-trip through the Claude subscription",
  { skip: liveSkip, timeout: 300_000 },
  async () => {
    const relay = await startRelayServer({
      environment: {
        ...process.env,
        CLAUDE_RELAY_PORT: "0",
        CLAUDE_RELAY_API_KEY: "integration-relay-key",
        // Planted metered credentials: the provider must strip these before
        // spawning Claude, or the request fails with an auth error.
        ANTHROPIC_API_KEY: "sk-ant-api03-planted-invalid-key",
        ANTHROPIC_AUTH_TOKEN: "planted-invalid-bearer",
      },
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${relay.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer integration-relay-key",
          },
          body: JSON.stringify({
            model: "claude-relay-default",
            messages: [
              {
                role: "user",
                content: "Reply exactly with CLAUDE RELAY HTTP WORKS",
              },
            ],
          }),
        },
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.object, "chat.completion");
      assert.match(body.choices[0].message.content, /CLAUDE RELAY HTTP WORKS/u);
      assert.ok(!JSON.stringify(body).includes(liveToken));
    } finally {
      await relay.close();
    }
  },
);

test(
  "integration: two-step tool-call loop through the Claude subscription",
  { skip: liveSkip, timeout: 600_000 },
  async () => {
    const relay = await startRelayServer({
      environment: {
        ...process.env,
        CLAUDE_RELAY_PORT: "0",
        CLAUDE_RELAY_API_KEY: "integration-relay-key",
      },
    });
    const post = (payload) =>
      fetch(`http://127.0.0.1:${relay.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer integration-relay-key",
        },
        body: JSON.stringify(payload),
      });
    try {
      // Step 1: tool_choice=required must force a schema-valid tool call.
      const first = await post({
        model: "claude-relay-default",
        tools: [MULTIPLY_TOOL],
        tool_choice: "required",
        messages: [
          { role: "user", content: "Use multiply_numbers to multiply 23 by 17." },
        ],
      });
      await assertOkResponse(first, "step 1 (tool_choice=required)");
      const firstBody = await first.json();
      const message = firstBody.choices[0].message;
      assert.equal(firstBody.choices[0].finish_reason, "tool_calls");
      assert.equal(message.content, null);
      assert.equal(message.tool_calls.length >= 1, true);
      const call = message.tool_calls[0];
      assert.equal(call.function.name, "multiply_numbers");
      assert.equal(typeof call.function.arguments, "string");
      const parsedArguments = JSON.parse(call.function.arguments);
      assert.deepEqual(
        [parsedArguments.a, parsedArguments.b].sort((x, y) => x - y),
        [17, 23],
      );

      // Step 2: this test acts as the orchestrator - it "executes" the tool
      // (multiplication) and returns the result. Claude must produce a final
      // answer that uses it.
      const second = await post({
        model: "claude-relay-default",
        tools: [MULTIPLY_TOOL],
        messages: [
          { role: "user", content: "Use multiply_numbers to multiply 23 by 17." },
          { role: "assistant", content: null, tool_calls: [call] },
          { role: "tool", tool_call_id: call.id, content: "391" },
        ],
      });
      await assertOkResponse(second, "step 2 (tool result follow-up, auto mode)");
      const secondBody = await second.json();
      assert.equal(secondBody.choices[0].finish_reason, "stop");
      assert.match(secondBody.choices[0].message.content, /391/u);
      assert.ok(!JSON.stringify(secondBody).includes(liveToken));
    } finally {
      await relay.close();
    }
  },
);
