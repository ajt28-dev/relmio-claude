// Build-time verification for the Claude Relay image. Proves - as the
// runtime user - that the Agent SDK imports and that its Linux platform
// runtime is installed, executable, and actually runs. The image build fails
// otherwise, so a missing optional dependency can never ship silently.
import { accessSync, constants, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

function fail(message) {
  console.error(`verify-runtime: ${message}`);
  process.exit(1);
}

const sdk = await import("@anthropic-ai/claude-agent-sdk");
if (typeof sdk.query !== "function") {
  fail("the Agent SDK did not export query()");
}

const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
let packageDirectory;
try {
  packageDirectory = dirname(require.resolve(`${platformPackage}/package.json`));
} catch {
  fail(
    `${platformPackage} is not installed. Optional platform dependencies were skipped (check --omit=optional / npm configuration).`,
  );
}

const binaries = readdirSync(packageDirectory).filter(
  (name) => !/\.(?:json|md)$/u.test(name),
);
if (binaries.length !== 1) {
  fail(`expected one runtime binary in ${platformPackage}, found: ${binaries.join(", ") || "none"}`);
}
const binaryPath = join(packageDirectory, binaries[0]);
try {
  accessSync(binaryPath, constants.X_OK);
} catch {
  fail(`${binaryPath} is not executable for uid ${process.getuid?.() ?? "?"}`);
}

const probe = spawnSync(binaryPath, ["--version"], {
  encoding: "utf8",
  timeout: 60_000,
  env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "" },
});
if (probe.error || probe.status !== 0) {
  fail(
    `${binaryPath} --version failed (status ${probe.status ?? "n/a"}): ${probe.error?.message ?? probe.stderr?.slice(0, 200) ?? ""}`,
  );
}

console.log(
  `verify-runtime: ok platform=${process.platform}-${process.arch} uid=${process.getuid?.() ?? "?"} binary=${binaries[0]} version=${probe.stdout.trim().split("\n")[0]}`,
);
