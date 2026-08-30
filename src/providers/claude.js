import { tmpdir } from "node:os";

const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 512;
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const DEFAULT_TIMEOUT_MS = 180_000;

// Claude Code resolves credentials in a fixed precedence order in which
// ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY outrank CLAUDE_CODE_OAUTH_TOKEN.
// A relay configured for subscription OAuth must therefore strip every
// higher-priority credential source from the environment handed to the Claude
// subprocess, or a leaked variable silently moves inference onto metered API
// billing without any error.
export const EXCLUDED_ENVIRONMENT_VARIABLES = Object.freeze([
  // Metered API credentials (precedence ranks 2 and 3).
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  // Cloud-provider selectors (precedence rank 1).
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  // Anthropic profile and Workload Identity Federation sources (rank 6, but
  // ANTHROPIC_PROFILE outranks the OAuth token variable).
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_WORKSPACE_ID",
  // Request rerouting and model overrides; the relay's own configuration must
  // stay authoritative for both.
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
]);

// The relay's Claude session is inference-only: n8n owns tool execution. Bare
// tool names remove the built-in tools from the model's context entirely.
export const DISALLOWED_BUILT_IN_TOOLS = Object.freeze([
  "Task",
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "ExitPlanMode",
  "SlashCommand",
  "Skill",
  "AskUserQuestion",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

function providerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function redactSecret(text, secret) {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  if (typeof secret !== "string" || secret.length === 0) {
    return text;
  }
  return text.split(secret).join("[redacted]");
}

function validateOauthToken(value) {
  if (typeof value !== "string") {
    return null;
  }
  const token = value.trim();
  if (
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    /[\s\u0000-\u001f\u007f]/u.test(token)
  ) {
    return null;
  }
  return token;
}

function validatePrompt(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PROMPT_BYTES
  ) {
    throw new TypeError("The Claude prompt is invalid.");
  }
  return value;
}

function validateSystemPrompt(value) {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SYSTEM_PROMPT_BYTES
  ) {
    throw new TypeError("The Claude system prompt is invalid.");
  }
  return value;
}

function validateModel(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !MODEL_PATTERN.test(value)) {
    throw new TypeError("The Claude model name is invalid.");
  }
  return value;
}

function validateOutputFormat(value) {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.type !== "json_schema" ||
    value.schema === null ||
    typeof value.schema !== "object" ||
    Array.isArray(value.schema)
  ) {
    throw new TypeError("The Claude output format is invalid.");
  }
  return { type: "json_schema", schema: value.schema };
}

function validateTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 900_000) {
    throw new TypeError("The Claude timeout is invalid.");
  }
  return value;
}

export function createClaudeEnvironment({ baseEnvironment, oauthToken }) {
  const token = validateOauthToken(oauthToken);
  if (token === null) {
    throw providerError(
      "missing_claude_token",
      "CLAUDE_CODE_OAUTH_TOKEN is not set or is invalid. Run `claude setup-token` on a machine with a Claude subscription and provide the token to the relay environment.",
    );
  }
  if (baseEnvironment === null || typeof baseEnvironment !== "object") {
    throw new TypeError("The Claude base environment is invalid.");
  }

  // Windows environment variable names are case-insensitive, so exclusion
  // must be case-insensitive too.
  const excluded = new Set(
    EXCLUDED_ENVIRONMENT_VARIABLES.map((name) => name.toUpperCase()),
  );
  const environment = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (value === undefined || excluded.has(name.toUpperCase())) {
      continue;
    }
    environment[name] = value;
  }

  environment.CLAUDE_CODE_OAUTH_TOKEN = token;
  // Keep filesystem memory out of relay inference and skip update checks and
  // other non-essential network traffic inside the sidecar.
  environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return environment;
}

async function loadDefaultQueryImplementation() {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    if (typeof sdk.query !== "function") {
      throw new TypeError("query export missing");
    }
    return sdk.query;
  } catch {
    throw providerError(
      "claude_sdk_unavailable",
      "The Claude Agent SDK is not installed. Run `npm ci --ignore-scripts` and try again.",
    );
  }
}

function collectAssistantText(message, previousText) {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return previousText;
  }
  let text = previousText;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

export async function queryClaude(
  { prompt, model, outputFormat, systemPrompt } = {},
  {
    environment = process.env,
    oauthToken = environment?.CLAUDE_CODE_OAUTH_TOKEN,
    queryImpl,
    cwd = tmpdir(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  const safePrompt = validatePrompt(prompt);
  const safeModel = validateModel(model);
  const safeOutputFormat = validateOutputFormat(outputFormat);
  const safeSystemPrompt = validateSystemPrompt(systemPrompt);
  const safeTimeoutMs = validateTimeout(timeoutMs);

  // createClaudeEnvironment re-validates the token and throws the actionable
  // missing-token error before any SDK code loads or any process spawns.
  const childEnvironment = createClaudeEnvironment({
    baseEnvironment: environment,
    oauthToken,
  });
  const token = childEnvironment.CLAUDE_CODE_OAUTH_TOKEN;

  const runQuery = queryImpl ?? (await loadDefaultQueryImplementation());

  const options = {
    env: childEnvironment,
    cwd,
    // No filesystem settings, no CLAUDE.md, no hooks: the relay's behavior
    // must come only from this request.
    settingSources: [],
    allowedTools: [],
    disallowedTools: [...DISALLOWED_BUILT_IN_TOOLS],
    // Inference-only: one model turn, no agentic tool loop.
    maxTurns: 1,
    ...(safeModel === undefined ? {} : { model: safeModel }),
    ...(safeSystemPrompt === undefined ? {} : { systemPrompt: safeSystemPrompt }),
    ...(safeOutputFormat === undefined ? {} : { outputFormat: safeOutputFormat }),
  };

  const stream = runQuery({ prompt: safePrompt, options });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      Promise.resolve(stream.interrupt?.()).catch(() => {});
    } catch {
      // Interrupt support depends on the SDK version; the timeout error below
      // still reports the failure.
    }
  }, safeTimeoutMs);
  timer.unref?.();

  let resultMessage = null;
  let assistantModel = null;
  let assistantText = "";
  try {
    for await (const message of stream) {
      if (message?.type === "assistant") {
        if (typeof message.message?.model === "string") {
          assistantModel = message.message.model;
        }
        assistantText = collectAssistantText(message, assistantText);
      } else if (message?.type === "result") {
        resultMessage = message;
      }
    }
  } catch (error) {
    if (timedOut) {
      throw providerError(
        "claude_timeout",
        "The Claude request timed out before completing.",
      );
    }
    const detail = redactSecret(error?.message ?? "", token);
    throw providerError(
      "claude_query_failed",
      detail === ""
        ? "The Claude session failed."
        : `The Claude session failed: ${detail}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    throw providerError(
      "claude_timeout",
      "The Claude request timed out before completing.",
    );
  }
  if (resultMessage === null) {
    throw providerError(
      "claude_protocol",
      "The Claude session ended without a result message.",
    );
  }
  if (resultMessage.subtype !== "success") {
    // The structured-output retry limit gets its own code so the relay can
    // report a deterministic schema failure instead of a generic one.
    const code =
      resultMessage.subtype === "error_max_structured_output_retries"
        ? "claude_structured_output_failed"
        : "claude_result_error";
    throw providerError(
      code,
      `The Claude session failed with result: ${redactSecret(
        String(resultMessage.subtype ?? "unknown"),
        token,
      )}`,
    );
  }

  return {
    text:
      typeof resultMessage.result === "string" && resultMessage.result !== ""
        ? resultMessage.result
        : assistantText,
    structuredOutput: resultMessage.structured_output ?? null,
    model: assistantModel,
    usage: resultMessage.usage ?? null,
    subtype: resultMessage.subtype,
  };
}
