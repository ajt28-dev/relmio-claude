import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

import packageManifest from "../../package.json" with { type: "json" };
import { queryClaude } from "../providers/claude.js";
import { hashRelayApiKey, loadRelayConfig } from "./config.js";
import {
  RelayHttpError,
  authenticationError,
  invalidRequest,
  mapProviderError,
  sendOpenAiError,
} from "./errors.js";
import { listRelayModels, resolveRelayModel } from "./models.js";
import { translateChatCompletionRequest } from "./openai/messages.js";
import { createChatCompletionResponse } from "./openai/completions.js";
import { parseToolConfig } from "./openai/tools.js";
import {
  createToolDecisionSchema,
  parseToolDecision,
  toOpenAiToolCalls,
} from "./openai/tool-decision.js";

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 2 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const BEARER_PATTERN = /^Bearer ([!-~]{8,256})$/u;
const CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset=utf-?8)?$/iu;

function headerOccurrences(request, expectedName) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === expectedName) {
      count += 1;
    }
  }
  return count;
}

function sendJson(response, status, body) {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const contents = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(contents),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(contents);
}

function hasValidRelayKey(request, verifier) {
  if (headerOccurrences(request, "authorization") !== 1) {
    return false;
  }
  const value = request.headers.authorization;
  if (typeof value !== "string" || value.length > 512) {
    return false;
  }
  const match = BEARER_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  return timingSafeEqual(hashRelayApiKey(match[1]), verifier);
}

function hasJsonContentType(request) {
  if (headerOccurrences(request, "content-type") !== 1) {
    return false;
  }
  const value = request.headers["content-type"];
  return typeof value === "string" && CONTENT_TYPE_PATTERN.test(value);
}

function readJsonBody(request, maxBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      // Reject without destroying the socket so the 413 response can still
      // be written; Node closes the connection after an unconsumed body.
      rejectPromise(
        new RelayHttpError({
          status: 413,
          message: "The request body is too large for this relay.",
          type: "invalid_request_error",
          code: "request_too_large",
        }),
      );
      return;
    }

    const chunks = [];
    let byteCount = 0;
    let settled = false;
    const settle = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise(value);
      }
    };

    request.on("data", (chunk) => {
      if (settled) {
        return;
      }
      byteCount += chunk.length;
      if (byteCount > maxBytes) {
        settle(
          new RelayHttpError({
            status: 413,
            message: "The request body is too large for this relay.",
            type: "invalid_request_error",
            code: "request_too_large",
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    request.once("error", () => {
      settle(new RelayHttpError({
        status: 400,
        message: "The request body could not be read.",
        type: "invalid_request_error",
        code: "invalid_body",
      }));
    });
    request.once("end", () => {
      settle(null, Buffer.concat(chunks));
    });
  });
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw invalidRequest("The request body is not valid JSON.", {
      code: "invalid_json",
    });
  }
}

// Structural shape of a request for compatibility debugging: field names,
// roles, and tool names only - never message contents, credentials, or
// argument values. Enabled with CLAUDE_RELAY_DEBUG=1.
function describeRequestShape(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return JSON.stringify({ body: typeof body });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return JSON.stringify({
    model: typeof body.model === "string" ? body.model : typeof body.model,
    keys: Object.keys(body).sort(),
    roles: messages.map((message) =>
      message?.role === "assistant" && Array.isArray(message.tool_calls)
        ? `assistant+tool_calls(${message.tool_calls.length})`
        : String(message?.role),
    ),
    content_kinds: messages.map((message) =>
      Array.isArray(message?.content) ? "array" : typeof message?.content,
    ),
    tool_names: tools.map((tool) => String(tool?.function?.name)),
    tool_choice:
      typeof body.tool_choice === "object" && body.tool_choice !== null
        ? `named:${String(body.tool_choice.function?.name)}`
        : String(body.tool_choice),
    parallel_tool_calls: String(body.parallel_tool_calls),
    stream: String(body.stream),
    has_response_format: body.response_format !== undefined,
  });
}

export function createRelayServer({
  config,
  queryProvider = queryClaude,
  maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
  maxBodyBytes = MAX_BODY_BYTES,
  log = () => {},
} = {}) {
  if (config === null || typeof config !== "object") {
    throw new TypeError("A relay configuration is required.");
  }
  let activeCompletions = 0;

  async function handleChatCompletion(request, response) {
    if (!hasJsonContentType(request)) {
      throw new RelayHttpError({
        status: 415,
        message: "Requests must use Content-Type: application/json.",
        type: "invalid_request_error",
        code: "unsupported_content_type",
      });
    }
    const body = parseJson(await readJsonBody(request, maxBodyBytes));
    if (config.debugShapes) {
      log(`request.shape ${describeRequestShape(body)}`);
    }
    const relayModelId = typeof body?.model === "string" ? body.model : "";
    const relayModel = resolveRelayModel(relayModelId);
    const toolConfig =
      body === null || typeof body !== "object" || Array.isArray(body)
        ? null
        : parseToolConfig(body);
    const { prompt, systemPrompt } = translateChatCompletionRequest(
      body,
      toolConfig,
    );

    if (activeCompletions >= maxConcurrentRequests) {
      throw new RelayHttpError({
        status: 429,
        message: "The relay is handling its maximum number of concurrent requests. Retry shortly.",
        type: "rate_limit_error",
        code: "relay_overloaded",
      });
    }

    activeCompletions += 1;
    const startedAt = Date.now();
    let providerResult;
    try {
      // Tool definitions never reach the provider as executable tools: the
      // provider request carries only prompt text, an optional system
      // prompt, the model, and the decision schema.
      providerResult = await queryProvider(
        {
          prompt,
          systemPrompt,
          model: relayModel.providerModel,
          ...(toolConfig === null
            ? {}
            : {
                outputFormat: {
                  type: "json_schema",
                  schema: createToolDecisionSchema(toolConfig),
                },
              }),
        },
        { environment: config.environment },
      );
    } catch (error) {
      throw mapProviderError(error);
    } finally {
      activeCompletions -= 1;
    }

    let toolCalls = null;
    let finalResult = providerResult;
    if (toolConfig !== null) {
      const decision = parseToolDecision(
        providerResult.structuredOutput,
        toolConfig,
      );
      if (decision.kind === "tool_calls") {
        toolCalls = toOpenAiToolCalls(decision.calls);
      } else {
        finalResult = { ...providerResult, text: decision.content };
      }
    }

    sendJson(
      response,
      200,
      createChatCompletionResponse({
        relayModel: relayModelId,
        providerResult: finalResult,
        toolCalls,
      }),
    );
    log(
      `chat.completion ok model=${finalResult.model ?? relayModelId} finish=${toolCalls === null ? "stop" : "tool_calls"} duration_ms=${Date.now() - startedAt}`,
    );
  }

  async function handleRequest(request, response) {
    if (
      headerOccurrences(request, "authorization") > 1 ||
      headerOccurrences(request, "content-type") > 1
    ) {
      throw invalidRequest("Duplicate authentication or content headers.", {
        code: "invalid_headers",
      });
    }
    if (headerOccurrences(request, "origin") > 0) {
      // The relay is a private backend-to-backend endpoint; browser clients
      // are rejected outright, mirroring the Relmio gateways.
      throw new RelayHttpError({
        status: 403,
        message: "Browser origins are not allowed.",
        type: "invalid_request_error",
        code: "origin_not_allowed",
      });
    }
    const rawUrl = typeof request.url === "string" ? request.url : "";
    if (Buffer.byteLength(rawUrl) > MAX_PATH_BYTES) {
      throw invalidRequest("The request path is too long.", {
        code: "invalid_path",
      });
    }
    const path = rawUrl.split("?", 1)[0];

    if (path === "/health") {
      if (request.method !== "GET") {
        throw new RelayHttpError({
          status: 405,
          message: "Use GET for /health.",
          type: "invalid_request_error",
          code: "method_not_allowed",
        });
      }
      // auth_mode reports configuration only: the relay is set up to use
      // subscription OAuth. It is not a claim that a provider round-trip
      // has been performed, and no credential material is ever included.
      sendJson(response, 200, {
        status: "ok",
        provider: "claude",
        auth_mode: "subscription_oauth",
        relay_auth: config.hasRelayAuth ? "enabled" : "disabled",
        relay_version: packageManifest.version,
      });
      return;
    }

    if (path.startsWith("/v1/")) {
      if (
        config.hasRelayAuth &&
        !hasValidRelayKey(request, config.apiKeyVerifier)
      ) {
        throw authenticationError(
          "Missing or invalid relay API key. Send Authorization: Bearer <CLAUDE_RELAY_API_KEY>.",
        );
      }
      if (path === "/v1/models") {
        if (request.method !== "GET") {
          throw new RelayHttpError({
            status: 405,
            message: "Use GET for /v1/models.",
            type: "invalid_request_error",
            code: "method_not_allowed",
          });
        }
        sendJson(response, 200, listRelayModels());
        return;
      }
      if (path === "/v1/chat/completions") {
        if (request.method !== "POST") {
          throw new RelayHttpError({
            status: 405,
            message: "Use POST for /v1/chat/completions.",
            type: "invalid_request_error",
            code: "method_not_allowed",
          });
        }
        await handleChatCompletion(request, response);
        return;
      }
    }

    throw new RelayHttpError({
      status: 404,
      message: `Unknown endpoint: ${request.method} ${path.slice(0, 128)}`,
      type: "invalid_request_error",
      code: "unknown_endpoint",
    });
  }

  return createServer(
    { maxHeaderSize: MAX_HEADER_BYTES },
    (request, response) => {
      handleRequest(request, response).catch((error) => {
        if (error instanceof RelayHttpError) {
          sendOpenAiError(response, error);
          return;
        }
        // Unexpected relay failure: never expose internals to the client.
        sendOpenAiError(
          response,
          new RelayHttpError({
            status: 500,
            message: "The relay failed to complete the request.",
            type: "api_error",
            code: "relay_error",
          }),
        );
        log(`relay_error ${error?.code ?? error?.message ?? "unknown"}`);
      });
    },
  );
}

export async function startRelayServer({
  environment = process.env,
  queryProvider,
  maxConcurrentRequests,
  log,
} = {}) {
  const config = loadRelayConfig(environment);
  const server = createRelayServer({
    config,
    ...(queryProvider === undefined ? {} : { queryProvider }),
    ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
    ...(log === undefined ? {} : { log }),
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  return {
    server,
    config,
    host: config.host,
    port: address.port,
    close() {
      return new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections?.();
      });
    },
  };
}
