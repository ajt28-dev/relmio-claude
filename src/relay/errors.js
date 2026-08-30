const MAX_PROVIDER_DETAIL_CHARS = 240;

const RATE_LIMIT_PATTERN =
  /rate[ _-]?limit|too many requests|usage limit|quota|overloaded|429/iu;

export class RelayHttpError extends Error {
  constructor({ status, message, type, param, code }) {
    super(message);
    this.status = status;
    this.type = type;
    this.param = param;
    this.code = code;
  }
}

export function invalidRequest(message, { param, code } = {}) {
  return new RelayHttpError({
    status: 400,
    message,
    type: "invalid_request_error",
    param,
    code,
  });
}

export function unsupportedFeature(message, param, code) {
  return invalidRequest(message, { param, code });
}

export function authenticationError(message) {
  return new RelayHttpError({
    status: 401,
    message,
    type: "authentication_error",
    code: "invalid_relay_api_key",
  });
}

function truncateDetail(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.length > MAX_PROVIDER_DETAIL_CHARS
    ? `${value.slice(0, MAX_PROVIDER_DETAIL_CHARS)}...`
    : value;
}

// Translate provider failures into stable OpenAI-shaped HTTP errors. The
// provider has already redacted the OAuth token from its messages; this layer
// additionally truncates so SDK internals never flood an HTTP client.
export function mapProviderError(error) {
  const code = error?.code;
  const detail = truncateDetail(error?.message ?? "");

  if (code === "missing_claude_token" || code === "claude_sdk_unavailable") {
    return new RelayHttpError({
      status: 503,
      message:
        "The relay's Claude credential is not configured. Check the relay environment.",
      type: "api_error",
      code: "provider_not_configured",
    });
  }
  if (code === "claude_structured_output_failed") {
    return new RelayHttpError({
      status: 502,
      message:
        "Claude could not produce a schema-valid tool decision after retries.",
      type: "api_error",
      code: "structured_output_failed",
    });
  }
  if (code === "claude_timeout") {
    return new RelayHttpError({
      status: 504,
      message: "The Claude request timed out before completing.",
      type: "api_error",
      code: "provider_timeout",
    });
  }
  if (code === "claude_result_error" || code === "claude_query_failed") {
    if (RATE_LIMIT_PATTERN.test(detail)) {
      return new RelayHttpError({
        status: 429,
        message:
          "The Claude subscription is currently rate limited. Retry later.",
        type: "rate_limit_error",
        code: "provider_rate_limited",
      });
    }
    return new RelayHttpError({
      status: 502,
      message: detail === "" ? "The Claude provider failed." : detail,
      type: "api_error",
      code: "provider_error",
    });
  }
  if (code === "claude_protocol") {
    return new RelayHttpError({
      status: 502,
      message: "The Claude provider returned an incomplete session.",
      type: "api_error",
      code: "provider_error",
    });
  }

  return new RelayHttpError({
    status: 500,
    message: "The relay failed to complete the request.",
    type: "api_error",
    code: "relay_error",
  });
}

export function sendOpenAiError(response, error) {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const body = JSON.stringify({
    error: {
      message: error.message,
      type: error.type ?? "api_error",
      param: error.param ?? null,
      code: error.code ?? null,
    },
  });
  response.writeHead(error.status ?? 500, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}
