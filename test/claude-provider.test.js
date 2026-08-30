import assert from "node:assert/strict";
import test from "node:test";

import {
  DISALLOWED_BUILT_IN_TOOLS,
  EXCLUDED_ENVIRONMENT_VARIABLES,
  createClaudeEnvironment,
  queryClaude,
} from "../src/providers/claude.js";

const FAKE_TOKEN = "sk-ant-oat01-FAKE-test-token-0123456789-abcdef";

function createFakeQuery(messages, capture = {}) {
  return Object.assign(
    function fakeQuery(invocation) {
      capture.invocation = invocation;
      capture.calls = (capture.calls ?? 0) + 1;
      return (async function* () {
        for (const message of messages) {
          yield message;
        }
      })();
    },
    { capture },
  );
}

function successMessages({ text = "CLAUDE RELAY WORKS", structured } = {}) {
  return [
    {
      type: "system",
      subtype: "init",
    },
    {
      type: "assistant",
      message: {
        model: "claude-sonnet-5",
        content: [{ type: "text", text }],
      },
    },
    {
      type: "result",
      subtype: "success",
      result: text,
      structured_output: structured,
      usage: { input_tokens: 12, output_tokens: 5 },
    },
  ];
}

test("createClaudeEnvironment strips metered and cloud credential sources", () => {
  const baseEnvironment = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    ANTHROPIC_API_KEY: "sk-ant-api03-should-never-survive",
    ANTHROPIC_AUTH_TOKEN: "bearer-should-never-survive",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
    ANTHROPIC_PROFILE: "work",
    ANTHROPIC_FEDERATION_RULE_ID: "rule",
    ANTHROPIC_ORGANIZATION_ID: "org",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svc",
    ANTHROPIC_IDENTITY_TOKEN: "jwt",
    ANTHROPIC_IDENTITY_TOKEN_FILE: "/tmp/jwt",
    ANTHROPIC_WORKSPACE_ID: "ws",
    ANTHROPIC_BASE_URL: "https://proxy.example.com",
    ANTHROPIC_MODEL: "claude-opus-5",
  };

  const environment = createClaudeEnvironment({
    baseEnvironment,
    oauthToken: FAKE_TOKEN,
  });

  for (const name of EXCLUDED_ENVIRONMENT_VARIABLES) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(environment, name),
      false,
      `${name} must not reach the Claude subprocess`,
    );
  }
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.HOME, "/home/user");
  assert.equal(environment.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN);
  assert.equal(environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  // The base environment object itself must stay untouched.
  assert.equal(
    baseEnvironment.ANTHROPIC_API_KEY,
    "sk-ant-api03-should-never-survive",
  );
});

test("createClaudeEnvironment strips excluded variables case-insensitively", () => {
  const environment = createClaudeEnvironment({
    baseEnvironment: {
      anthropic_api_key: "lowercase-leak",
      Anthropic_Auth_Token: "mixedcase-leak",
      Path: "C:\\Windows",
    },
    oauthToken: FAKE_TOKEN,
  });

  assert.equal(environment.anthropic_api_key, undefined);
  assert.equal(environment.Anthropic_Auth_Token, undefined);
  assert.equal(environment.Path, "C:\\Windows");
});

test("createClaudeEnvironment rejects a missing or malformed token", () => {
  for (const bad of [undefined, "", "   ", "with space", "x".repeat(600)]) {
    assert.throws(
      () =>
        createClaudeEnvironment({ baseEnvironment: {}, oauthToken: bad }),
      (error) =>
        error.code === "missing_claude_token" &&
        /CLAUDE_CODE_OAUTH_TOKEN/u.test(error.message) &&
        /claude setup-token/u.test(error.message),
    );
  }
});

test("createClaudeEnvironment accepts hyphenated setup-token values", () => {
  const environment = createClaudeEnvironment({
    baseEnvironment: {},
    oauthToken: "sk-ant-oat01-aB3-cD4_eF5-gH6",
  });
  assert.equal(
    environment.CLAUDE_CODE_OAUTH_TOKEN,
    "sk-ant-oat01-aB3-cD4_eF5-gH6",
  );
});

test("queryClaude fails fast without a token and never invokes the SDK", async () => {
  const fake = createFakeQuery(successMessages());

  await assert.rejects(
    queryClaude(
      { prompt: "hello" },
      { environment: {}, queryImpl: fake },
    ),
    (error) =>
      error.code === "missing_claude_token" &&
      /CLAUDE_CODE_OAUTH_TOKEN/u.test(error.message),
  );
  assert.equal(fake.capture.calls, undefined);
});

test("queryClaude hands the SDK a scrubbed, inference-only invocation", async () => {
  const fake = createFakeQuery(successMessages());

  const result = await queryClaude(
    { prompt: "Reply exactly with: CLAUDE RELAY WORKS", model: "sonnet" },
    {
      environment: {
        PATH: "/usr/bin",
        CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
        ANTHROPIC_API_KEY: "sk-ant-api03-planted-leak",
        ANTHROPIC_AUTH_TOKEN: "planted-bearer-leak",
      },
      queryImpl: fake,
    },
  );

  const { prompt, options } = fake.capture.invocation;
  assert.equal(prompt, "Reply exactly with: CLAUDE RELAY WORKS");
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN);
  assert.equal(options.model, "sonnet");
  assert.equal(options.maxTurns, 1);
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.systemPrompt, undefined);
  for (const tool of ["Bash", "Read", "Write", "Edit", "WebSearch", "Task"]) {
    assert.ok(
      options.disallowedTools.includes(tool),
      `${tool} must be disallowed`,
    );
  }
  assert.deepEqual(
    options.disallowedTools,
    [...DISALLOWED_BUILT_IN_TOOLS],
  );
  assert.equal(typeof options.cwd, "string");

  assert.equal(result.text, "CLAUDE RELAY WORKS");
  assert.equal(result.model, "claude-sonnet-5");
  assert.equal(result.subtype, "success");
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 5 });
  assert.equal(result.structuredOutput, null);
});

test("queryClaude passes outputFormat through and returns structured_output", async () => {
  const structured = { answer: "CLAUDE RELAY WORKS" };
  const fake = createFakeQuery(successMessages({ structured }));
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  };

  const result = await queryClaude(
    {
      prompt: "Answer as JSON.",
      outputFormat: { type: "json_schema", schema },
    },
    {
      environment: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
      queryImpl: fake,
    },
  );

  assert.deepEqual(fake.capture.invocation.options.outputFormat, {
    type: "json_schema",
    schema,
  });
  assert.deepEqual(result.structuredOutput, structured);
});

test("queryClaude redacts the OAuth token from SDK failure messages", async () => {
  const fake = function fakeQuery() {
    return (async function* () {
      yield { type: "system", subtype: "init" };
      throw new Error(`upstream exploded while sending ${FAKE_TOKEN} header`);
    })();
  };

  await assert.rejects(
    queryClaude(
      { prompt: "hello" },
      {
        environment: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
        queryImpl: fake,
      },
    ),
    (error) => {
      assert.equal(error.code, "claude_query_failed");
      assert.ok(!error.message.includes(FAKE_TOKEN), "token must be redacted");
      assert.match(error.message, /\[redacted\]/u);
      return true;
    },
  );
});

test("queryClaude surfaces a non-success result subtype as an error", async () => {
  const fake = createFakeQuery([
    { type: "result", subtype: "error_max_turns" },
  ]);

  await assert.rejects(
    queryClaude(
      { prompt: "hello" },
      {
        environment: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
        queryImpl: fake,
      },
    ),
    (error) =>
      error.code === "claude_result_error" &&
      /error_max_turns/u.test(error.message),
  );
});

test("queryClaude maps structured-output retry exhaustion to its own code", async () => {
  const fake = createFakeQuery([
    { type: "result", subtype: "error_max_structured_output_retries" },
  ]);

  await assert.rejects(
    queryClaude(
      { prompt: "hello" },
      {
        environment: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
        queryImpl: fake,
      },
    ),
    (error) => error.code === "claude_structured_output_failed",
  );
});

test("queryClaude times out and interrupts a hung session", async () => {
  let interrupted = false;
  const fake = function fakeQuery() {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    return {
      async next() {
        await gate;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async interrupt() {
        interrupted = true;
        release();
      },
    };
  };

  await assert.rejects(
    queryClaude(
      { prompt: "hello" },
      {
        environment: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
        queryImpl: fake,
        timeoutMs: 1_000,
      },
    ),
    (error) => error.code === "claude_timeout",
  );
  assert.equal(interrupted, true);
});

test("queryClaude validates request fields before touching the environment", async () => {
  const fake = createFakeQuery(successMessages());
  const dependencies = {
    environment: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
    queryImpl: fake,
  };

  await assert.rejects(queryClaude({ prompt: "" }, dependencies), TypeError);
  await assert.rejects(
    queryClaude({ prompt: "ok", model: "bad model!" }, dependencies),
    TypeError,
  );
  await assert.rejects(
    queryClaude(
      { prompt: "ok", outputFormat: { type: "text" } },
      dependencies,
    ),
    TypeError,
  );
  await assert.rejects(
    queryClaude({ prompt: "ok" }, { ...dependencies, timeoutMs: 10 }),
    TypeError,
  );
  assert.equal(fake.capture.calls, undefined);
});

// ---------------------------------------------------------------------------
// Integration tests. These spawn the real bundled Claude Code binary through
// the Agent SDK and require a subscription OAuth token from `claude
// setup-token`. They are skipped cleanly when the token is absent so the
// normal suite stays runnable without a Claude subscription.
//
// Run them with:
//   CLAUDE_CODE_OAUTH_TOKEN=... node --test test/claude-provider.test.js
// ---------------------------------------------------------------------------

const realToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const integrationSkip = realToken
  ? false
  : "CLAUDE_CODE_OAUTH_TOKEN is not set";

test(
  "integration: headless subscription query survives a planted API key",
  { skip: integrationSkip, timeout: 300_000 },
  async () => {
    const result = await queryClaude(
      { prompt: "Reply exactly with: CLAUDE RELAY WORKS", model: "sonnet" },
      {
        environment: {
          ...process.env,
          // Deliberately planted invalid metered credentials. If the provider
          // failed to strip them they would outrank the OAuth token and the
          // request would fail with an authentication error, so a successful
          // reply proves both headless OAuth auth and credential isolation.
          ANTHROPIC_API_KEY: "sk-ant-api03-planted-invalid-key",
          ANTHROPIC_AUTH_TOKEN: "planted-invalid-bearer",
        },
        timeoutMs: 240_000,
      },
    );

    assert.match(result.text, /CLAUDE RELAY WORKS/u);
    assert.equal(result.subtype, "success");
    assert.equal(typeof result.model, "string");
    assert.ok(!result.text.includes(realToken), "token must never surface");
  },
);

test(
  "integration: structured output returns schema-validated JSON",
  { skip: integrationSkip, timeout: 300_000 },
  async () => {
    const result = await queryClaude(
      {
        prompt: "State the answer exactly: CLAUDE RELAY WORKS",
        model: "sonnet",
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        },
      },
      { environment: { ...process.env }, timeoutMs: 240_000 },
    );

    assert.equal(result.subtype, "success");
    assert.ok(
      result.structuredOutput !== null,
      "structured_output must be present",
    );
    assert.match(result.structuredOutput.answer, /CLAUDE RELAY WORKS/u);
  },
);
