import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DOCKER_DIRECTORY = "docker/claude-relay";

async function readDockerAsset(name) {
  return readFile(`${DOCKER_DIRECTORY}/${name}`, "utf8");
}

test("Claude Relay Docker assets exist", async () => {
  for (const name of [
    "Dockerfile",
    "compose.example.yml",
    ".env.example",
    "verify-runtime.mjs",
    "DEPLOY.md",
  ]) {
    assert.ok((await readDockerAsset(name)).length > 0, `${name} is empty`);
  }
  assert.ok((await readFile(".dockerignore", "utf8")).length > 0);
});

test("Dockerfile runs the proven relay as a non-root user on Debian Node", async () => {
  const dockerfile = await readDockerAsset("Dockerfile");

  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/mu);
  assert.doesNotMatch(dockerfile, /alpine/iu);
  assert.match(dockerfile, /^RUN npm ci --omit=dev/mu);
  assert.match(dockerfile, /^COPY package\.json package-lock\.json \.npmrc \.\/$/mu);
  assert.doesNotMatch(dockerfile, /COPY .*node_modules/u, "node_modules must be installed in Linux, not copied");
  assert.doesNotMatch(dockerfile, /COPY .*\.env(?!\.example)/u, ".env must never be copied");
  assert.doesNotMatch(dockerfile, /^ADD /mu);
  assert.doesNotMatch(dockerfile, /--ignore-scripts=false|ignore-scripts false/u);

  // Same relay entry point as local development.
  assert.match(dockerfile, /^ENTRYPOINT \["node", "src\/relay\/main\.js"\]$/mu);
  assert.match(dockerfile, /^EXPOSE 10532$/mu);
  assert.match(dockerfile, /CLAUDE_RELAY_HOST=0\.0\.0\.0/u);
  assert.match(dockerfile, /CLAUDE_RELAY_PORT=10532/u);
  assert.match(dockerfile, /HOME=\/home\/node/u);

  // The final USER instruction must be the non-root node user.
  const userInstructions = dockerfile.match(/^USER .+$/gmu);
  assert.ok(userInstructions.length > 0);
  assert.equal(userInstructions.at(-1), "USER node");

  // Linux runtime verification runs as the runtime user and is then removed.
  assert.match(dockerfile, /^USER node\nRUN node \.\/verify-runtime\.mjs$/mu);
  assert.match(dockerfile, /^RUN rm \.\/verify-runtime\.mjs$/mu);

  // Healthcheck uses Node, hits the unauthenticated /health, never Claude.
  assert.match(dockerfile, /^HEALTHCHECK /mu);
  assert.match(dockerfile, /http:\/\/127\.0\.0\.1:10532\/health/u);
  assert.doesNotMatch(dockerfile, /chat\/completions/u);
  assert.doesNotMatch(dockerfile, /curl/u);

  // No credential material of any kind.
  assert.doesNotMatch(dockerfile, /sk-ant|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/u);
});

test("compose example is a private, hardened, unpublished sidecar", async () => {
  const compose = await readDockerAsset("compose.example.yml");
  const active = compose
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");

  assert.match(active, /^\s+container_name: n8n-claude-relay$/mu);
  assert.match(active, /^\s+- n8n-claude-relay$/mu, "Docker DNS alias");
  assert.match(active, /dockerfile: docker\/claude-relay\/Dockerfile/u);

  // No host port publishing of any form.
  assert.doesNotMatch(active, /^\s+ports:/mu);
  assert.doesNotMatch(active, /\d+:10532/u);
  assert.match(active, /^\s+expose:\n\s+- "10532"$/mu);

  // Hardening.
  assert.match(active, /^\s+cap_drop:\n\s+- ALL$/mu);
  assert.match(active, /no-new-privileges:true/u);
  assert.match(active, /^\s+restart: unless-stopped$/mu);
  assert.doesNotMatch(active, /privileged/u);
  assert.doesNotMatch(active, /docker\.sock/u);
  assert.doesNotMatch(active, /network_mode/u);
  assert.doesNotMatch(active, /cap_add/u);
  assert.doesNotMatch(active, /traefik/iu);
  assert.doesNotMatch(active, /tls|certresolver|entrypoints/iu);

  // Internal bind and port.
  assert.match(active, /CLAUDE_RELAY_HOST: 0\.0\.0\.0/u);
  assert.match(active, /CLAUDE_RELAY_PORT: "10532"/u);

  // Secrets are interpolated from .env, never literal.
  assert.match(active, /CLAUDE_CODE_OAUTH_TOKEN: \$\{CLAUDE_CODE_OAUTH_TOKEN:\?/u);
  assert.match(active, /CLAUDE_RELAY_API_KEY: \$\{CLAUDE_RELAY_API_KEY:\?/u);
  assert.doesNotMatch(active, /sk-ant-/u);
  assert.doesNotMatch(active, /env_file/u);

  // External, configurable n8n network; no hardcoded network name.
  assert.match(active, /^\s+external: true$/mu);
  assert.match(active, /name: \$\{N8N_DOCKER_NETWORK:\?/u);
  assert.doesNotMatch(active, /name: (?:proxy|default|n8n-network)\s*$/mu);

  // Resource configuration: no tiny Relmio cap, no aggressive CPU quota.
  assert.doesNotMatch(active, /mem_limit: 512m/u);
  assert.doesNotMatch(active, /^\s+cpus:/mu);

  // Only relay-owned writable locations; no host directories mounted.
  assert.match(active, /n8n-claude-relay-home:\/home\/node/u);
  assert.match(active, /- \/tmp:size=/u);
  assert.doesNotMatch(active, /^\s+- \/(?:root|home|etc|var)[\/:]/mu);
  // read_only stays a documented post-validation step, not active by default.
  assert.doesNotMatch(active, /^\s+read_only: true/mu);
});

test("env example carries placeholders only and .env stays out of git and images", async () => {
  const envExample = await readDockerAsset(".env.example");
  assert.match(envExample, /^CLAUDE_CODE_OAUTH_TOKEN=REPLACE_ME$/mu);
  assert.match(envExample, /^CLAUDE_RELAY_API_KEY=REPLACE_WITH_RANDOM_SECRET$/mu);
  assert.match(envExample, /^N8N_DOCKER_NETWORK=REPLACE_ME$/mu);
  assert.match(envExample, /openssl rand -hex 32/u);
  assert.match(envExample, /chmod 600/u);
  assert.doesNotMatch(envExample, /sk-ant-/u);

  const gitignore = await readFile(".gitignore", "utf8");
  assert.match(gitignore, /^\.env$/mu);
  assert.match(gitignore, /^\.env\.\*$/mu);
  assert.match(gitignore, /^!\.env\.example$/mu);

  const dockerignore = await readFile(".dockerignore", "utf8");
  for (const pattern of [
    ".git",
    "node_modules",
    ".env",
    ".env.*",
    "test",
    "coverage",
    "*.log",
    "auth.json",
    ".claude",
  ]) {
    assert.ok(
      dockerignore.split("\n").includes(pattern),
      `.dockerignore must exclude ${pattern}`,
    );
  }
  assert.ok(dockerignore.split("\n").includes("!docker/claude-relay/.env.example"));
});

test("runtime verifier proves the Linux Agent SDK binary rather than assuming it", async () => {
  const verifier = await readDockerAsset("verify-runtime.mjs");
  assert.match(verifier, /claude-agent-sdk-\$\{process\.platform\}-\$\{process\.arch\}/u);
  assert.match(verifier, /constants\.X_OK/u);
  assert.match(verifier, /--version/u);
  assert.match(verifier, /process\.exit\(1\)/u);
});

test("deployment guide covers the critical safety checks", async () => {
  const guide = await readDockerAsset("DEPLOY.md");
  assert.match(guide, /chmod 600 \.env/u);
  assert.match(guide, /HostConfig\.PortBindings/u);
  assert.match(guide, /0\.0\.0\.0:10532->10532\/tcp/u);
  assert.match(guide, /http:\/\/n8n-claude-relay:10532\/v1/u);
  assert.match(guide, /CLAUDE DOCKER RELAY WORKS/u);
  assert.match(guide, /Use Responses API/u);
  assert.match(guide, /724024/u);
  assert.match(guide, /docker compose down/u);
  assert.doesNotMatch(guide, /sk-ant-oat/u);
});
