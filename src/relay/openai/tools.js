import { invalidRequest } from "../errors.js";

// OpenAI function names are letters, digits, underscores, dots, and dashes.
// n8n/LangChain-generated names ("Calculator", "Google_Sheets-read_rows")
// stay within this set. Length is capped well above OpenAI's own limit so
// generated names never fail, while path or shell metacharacters cannot pass.
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,128}$/u;

const MAX_TOOLS = 128;
const MAX_DESCRIPTION_CHARS = 8_192;
const MAX_PARAMETERS_BYTES = 128 * 1_024;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidTools(message, param) {
  return invalidRequest(message, { param, code: "invalid_tools" });
}

function invalidToolChoice(message) {
  return invalidRequest(message, {
    param: "tool_choice",
    code: "invalid_tool_choice",
  });
}

function validateToolDefinition(entry, index) {
  const param = `tools[${index}]`;
  if (!isPlainObject(entry)) {
    throw invalidTools(`${param} must be an object.`, param);
  }
  if (entry.type !== "function") {
    throw invalidTools(`${param}.type must be "function".`, `${param}.type`);
  }
  if (!isPlainObject(entry.function)) {
    throw invalidTools(`${param}.function must be an object.`, `${param}.function`);
  }
  const { name, description, parameters } = entry.function;
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
    throw invalidTools(
      `${param}.function.name must match ${String(TOOL_NAME_PATTERN)}.`,
      `${param}.function.name`,
    );
  }
  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" ||
      description.length > MAX_DESCRIPTION_CHARS)
  ) {
    throw invalidTools(
      `${param}.function.description must be a string of at most ${MAX_DESCRIPTION_CHARS} characters.`,
      `${param}.function.description`,
    );
  }
  if (parameters !== undefined && parameters !== null) {
    if (!isPlainObject(parameters)) {
      throw invalidTools(
        `${param}.function.parameters must be a JSON Schema object.`,
        `${param}.function.parameters`,
      );
    }
    if (Buffer.byteLength(JSON.stringify(parameters)) > MAX_PARAMETERS_BYTES) {
      throw invalidTools(
        `${param}.function.parameters is too large.`,
        `${param}.function.parameters`,
      );
    }
  }
  return {
    name,
    description:
      typeof description === "string" && description !== ""
        ? description
        : undefined,
    parameters: isPlainObject(parameters) ? parameters : undefined,
  };
}

function parseToolChoice(value, toolNames) {
  if (value === undefined || value === null || value === "auto") {
    return { mode: "auto", namedToolName: undefined };
  }
  if (value === "none") {
    return { mode: "none", namedToolName: undefined };
  }
  if (value === "required") {
    return { mode: "required", namedToolName: undefined };
  }
  if (
    isPlainObject(value) &&
    value.type === "function" &&
    isPlainObject(value.function) &&
    typeof value.function.name === "string"
  ) {
    const name = value.function.name;
    if (!toolNames.has(name)) {
      throw invalidToolChoice(
        `tool_choice names the function \`${name.slice(0, 128)}\`, which is not present in tools.`,
      );
    }
    return { mode: "named", namedToolName: name };
  }
  throw invalidToolChoice(
    'tool_choice must be "auto", "none", "required", or {"type":"function","function":{"name":...}}.',
  );
}

// Parse the request's tool surface into a validated, inert description set.
// Tool definitions are data only: they are rendered into prompts and schemas
// and are never registered with the Agent SDK as executable tools.
export function parseToolConfig(body) {
  const tools = body.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;

  if (!hasTools) {
    if (tools !== undefined && tools !== null && !Array.isArray(tools)) {
      throw invalidTools("tools must be an array.", "tools");
    }
    // Harmless no-op choices are tolerated without tools; choices that
    // require a tool to exist are rejected.
    const choice = body.tool_choice;
    if (
      choice !== undefined &&
      choice !== null &&
      choice !== "auto" &&
      choice !== "none"
    ) {
      throw invalidToolChoice(
        "tool_choice requires a non-empty tools array.",
      );
    }
    return null;
  }

  if (tools.length > MAX_TOOLS) {
    throw invalidTools(`tools may contain at most ${MAX_TOOLS} entries.`, "tools");
  }

  const parsed = tools.map(validateToolDefinition);
  const names = new Set();
  for (const [index, tool] of parsed.entries()) {
    if (names.has(tool.name)) {
      throw invalidTools(
        `tools contains the duplicate function name \`${tool.name}\`.`,
        `tools[${index}].function.name`,
      );
    }
    names.add(tool.name);
  }

  const { mode, namedToolName } = parseToolChoice(body.tool_choice, names);

  const parallelValue = body.parallel_tool_calls;
  if (
    parallelValue !== undefined &&
    parallelValue !== null &&
    typeof parallelValue !== "boolean"
  ) {
    throw invalidRequest("parallel_tool_calls must be a boolean.", {
      param: "parallel_tool_calls",
      code: "invalid_parallel_tool_calls",
    });
  }

  return {
    tools: parsed,
    mode,
    namedToolName,
    parallel: parallelValue !== false,
  };
}
