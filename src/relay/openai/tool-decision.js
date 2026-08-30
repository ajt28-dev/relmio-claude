import { randomBytes } from "node:crypto";

import { RelayHttpError } from "../errors.js";

const MAX_PARALLEL_CALLS = 16;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function structuredOutputFailure(detail) {
  return new RelayHttpError({
    status: 502,
    message:
      detail === undefined
        ? "Claude did not produce a valid tool decision."
        : `Claude did not produce a valid tool decision: ${detail}`,
    type: "api_error",
    code: "structured_output_failed",
  });
}

function stripSchemaDeclarations(value) {
  if (Array.isArray(value)) {
    return value.map(stripSchemaDeclarations);
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      // The Agent SDK validates with JSON Schema draft-07 and rejects
      // schemas that declare a newer dialect, so any embedded $schema
      // declaration from the client is removed.
      if (key === "$schema") {
        continue;
      }
      result[key] = stripSchemaDeclarations(entry);
    }
    return result;
  }
  return value;
}

// A tool with no declared parameters accepts only an empty arguments object.
export function sanitizeParameterSchema(parameters) {
  if (parameters === undefined) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return stripSchemaDeclarations(JSON.parse(JSON.stringify(parameters)));
}

function finalBranch() {
  return {
    type: "object",
    properties: {
      type: { const: "final" },
      content: { type: "string" },
    },
    required: ["type", "content"],
    additionalProperties: false,
  };
}

function callItemSchema(tool) {
  return {
    type: "object",
    properties: {
      name: { const: tool.name },
      arguments: sanitizeParameterSchema(tool.parameters),
    },
    required: ["name", "arguments"],
    additionalProperties: false,
  };
}

function callsSchema(tools, parallel) {
  // The nested per-tool oneOf is proven live: the required-mode tool-call
  // step passes with it. Only TOP-LEVEL union keywords are rejected by the
  // structured-output custom tool.
  return {
    type: "array",
    minItems: 1,
    maxItems: parallel ? MAX_PARALLEL_CALLS : 1,
    items:
      tools.length === 1
        ? callItemSchema(tools[0])
        : { oneOf: tools.map(callItemSchema) },
  };
}

function toolCallsBranch(tools, parallel) {
  return {
    type: "object",
    properties: {
      type: { const: "tool_calls" },
      calls: callsSchema(tools, parallel),
    },
    required: ["type", "calls"],
    additionalProperties: false,
  };
}

// Auto mode cannot be a top-level union: Anthropic's structured-output
// custom tool rejects root oneOf/allOf/anyOf (live 400: "input_schema does
// not support oneOf, allOf, or anyOf at the top level"). The flat root
// object enforces the common structure and the `type` discriminator; the
// final/tool_calls field exclusivity is enforced by parseToolDecision.
function autoDecisionSchema(tools, parallel) {
  return {
    type: "object",
    properties: {
      type: { type: "string", enum: ["final", "tool_calls"] },
      content: { type: "string" },
      calls: callsSchema(tools, parallel),
    },
    required: ["type"],
    additionalProperties: false,
  };
}

// Build the schema that constrains Claude's decision. tool_choice modes are
// enforced at the schema level, not merely through prompt wording: "none"
// admits only a final answer, "required" and named modes admit only tool
// calls, and a named mode admits only the requested function.
export function createToolDecisionSchema({ tools, mode, namedToolName, parallel }) {
  if (mode === "none") {
    return finalBranch();
  }
  const activeTools =
    mode === "named"
      ? tools.filter((tool) => tool.name === namedToolName)
      : tools;
  if (mode === "required" || mode === "named") {
    return toolCallsBranch(activeTools, parallel);
  }
  return autoDecisionSchema(activeTools, parallel);
}

// Defensive re-validation of the SDK-validated structured output before it
// is translated into OpenAI fields. Anything off-contract is a provider
// failure, never a fabricated final answer.
export function parseToolDecision(structuredOutput, { tools, mode, namedToolName }) {
  if (!isPlainObject(structuredOutput)) {
    throw structuredOutputFailure("no structured output was returned");
  }
  if (structuredOutput.type === "final") {
    if (mode === "required" || mode === "named") {
      throw structuredOutputFailure(
        "a final answer was returned although a tool call was required",
      );
    }
    if (typeof structuredOutput.content !== "string") {
      throw structuredOutputFailure("the final content is not a string");
    }
    // The flat auto schema cannot express final/tool_calls exclusivity, so
    // the parser enforces it: a final decision must not carry calls.
    if (Object.hasOwn(structuredOutput, "calls")) {
      throw structuredOutputFailure("a final decision must not include calls");
    }
    return { kind: "final", content: structuredOutput.content };
  }
  if (structuredOutput.type === "tool_calls") {
    if (mode === "none") {
      throw structuredOutputFailure(
        'a tool call was returned although tool_choice was "none"',
      );
    }
    if (Object.hasOwn(structuredOutput, "content")) {
      throw structuredOutputFailure(
        "a tool_calls decision must not include content",
      );
    }
    const allowedNames =
      mode === "named"
        ? new Set([namedToolName])
        : new Set(tools.map((tool) => tool.name));
    const calls = structuredOutput.calls;
    if (!Array.isArray(calls) || calls.length === 0) {
      throw structuredOutputFailure("the tool call list is empty");
    }
    if (calls.length > MAX_PARALLEL_CALLS) {
      throw structuredOutputFailure("too many tool calls were returned");
    }
    const validated = calls.map((call) => {
      if (
        !isPlainObject(call) ||
        typeof call.name !== "string" ||
        !allowedNames.has(call.name) ||
        !isPlainObject(call.arguments)
      ) {
        throw structuredOutputFailure("a tool call did not match the schema");
      }
      return { name: call.name, arguments: call.arguments };
    });
    return { kind: "tool_calls", calls: validated };
  }
  throw structuredOutputFailure("the decision type is unknown");
}

export function createToolCallId(random = randomBytes) {
  return `call_${random(12).toString("hex")}`;
}

// OpenAI wire shape: function.arguments is a JSON *string*, and every call
// gets a unique random ID so concurrent requests can never collide.
export function toOpenAiToolCalls(calls, createId = createToolCallId) {
  return calls.map((call) => ({
    id: createId(),
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  }));
}
