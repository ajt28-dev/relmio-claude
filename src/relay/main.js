#!/usr/bin/env node

// Development entry point for the Claude Relay HTTP server. Started with:
//   npm run relay
// Configuration comes from the environment; see src/relay/config.js.
// This process must never print credential material.

import { startRelayServer } from "./server.js";

let relay;
try {
  relay = await startRelayServer({ log: console.log });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

console.log("");
console.log("Claude Relay");
console.log("------------");
console.log(`Listening on http://${relay.host}:${relay.port}`);
console.log(
  relay.config.hasRelayAuth
    ? "Relay auth: enabled (Authorization: Bearer <CLAUDE_RELAY_API_KEY> required for /v1/*)"
    : "Relay auth: disabled (set CLAUDE_RELAY_API_KEY to require a bearer key)",
);
console.log("Claude auth mode: subscription_oauth");
console.log("Press Control+C to stop.");
console.log("");

let closing = false;
async function shutdown() {
  if (closing) {
    return;
  }
  closing = true;
  await relay.close();
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
