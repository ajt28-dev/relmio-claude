import { createHash } from "node:crypto";
import { isIP } from "node:net";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 10532;
const MIN_API_KEY_LENGTH = 8;
const MAX_API_KEY_LENGTH = 256;

function configError(message) {
  return Object.assign(new Error(message), { code: "relay_config" });
}

function validateHost(value) {
  if (value === undefined || value === "") {
    return DEFAULT_HOST;
  }
  if (
    typeof value !== "string" ||
    (isIP(value) === 0 && value !== "localhost")
  ) {
    throw configError("CLAUDE_RELAY_HOST must be an IP address or localhost.");
  }
  return value;
}

function validatePort(value) {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  if (typeof value !== "string" || !/^[0-9]{1,5}$/u.test(value)) {
    throw configError("CLAUDE_RELAY_PORT must be a number between 0 and 65535.");
  }
  const port = Number(value);
  // Port 0 requests an ephemeral port, which the test suite relies on.
  if (port > 65_535) {
    throw configError("CLAUDE_RELAY_PORT must be a number between 0 and 65535.");
  }
  return port;
}

function validateApiKey(value) {
  if (value === undefined || value === "") {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length < MIN_API_KEY_LENGTH ||
    value.length > MAX_API_KEY_LENGTH ||
    !/^[!-~]+$/u.test(value)
  ) {
    throw configError(
      `CLAUDE_RELAY_API_KEY must be ${MIN_API_KEY_LENGTH}-${MAX_API_KEY_LENGTH} printable characters with no spaces.`,
    );
  }
  return value;
}

export function hashRelayApiKey(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function loadRelayConfig(environment = process.env) {
  if (environment === null || typeof environment !== "object") {
    throw new TypeError("The relay environment is invalid.");
  }

  // Fail fast on a missing Claude credential so the operator learns at
  // startup, not on the first proxied request. Detailed token validation
  // stays in the provider, which re-checks on every call.
  const oauthToken = environment.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof oauthToken !== "string" || oauthToken.trim() === "") {
    throw configError(
      "CLAUDE_CODE_OAUTH_TOKEN is not set. Run `claude setup-token` on a machine with a Claude subscription and provide the token to the relay environment.",
    );
  }

  const apiKey = validateApiKey(environment.CLAUDE_RELAY_API_KEY);

  return {
    host: validateHost(environment.CLAUDE_RELAY_HOST),
    port: validatePort(environment.CLAUDE_RELAY_PORT),
    // Only a SHA-256 verifier is kept for request checks; the raw key is
    // never attached to the config object handed around the server.
    apiKeyVerifier: apiKey === null ? null : hashRelayApiKey(apiKey),
    hasRelayAuth: apiKey !== null,
    // Structural request-shape logging for n8n compatibility debugging.
    debugShapes: environment.CLAUDE_RELAY_DEBUG === "1",
    environment,
  };
}
