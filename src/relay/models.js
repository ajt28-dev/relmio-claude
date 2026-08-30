import { RelayHttpError } from "./errors.js";

// One deliberately generic model for Phase 2. `providerModel: undefined`
// means the provider omits the model option entirely, so the Claude Agent
// SDK's own configured default subscription model is used. The provider
// reports the model Claude actually served, and the relay returns that in
// completion responses, so no Anthropic model ID is hardcoded here.
export const RELAY_MODELS = Object.freeze({
  "claude-relay-default": Object.freeze({
    providerModel: undefined,
    ownedBy: "claude-relay",
  }),
});

export function listRelayModels() {
  return {
    object: "list",
    data: Object.entries(RELAY_MODELS).map(([id, model]) => ({
      id,
      object: "model",
      owned_by: model.ownedBy,
    })),
  };
}

export function resolveRelayModel(value) {
  if (typeof value !== "string" || value === "") {
    throw new RelayHttpError({
      status: 400,
      message: "The model field is required.",
      type: "invalid_request_error",
      param: "model",
      code: "model_required",
    });
  }
  const model = RELAY_MODELS[value];
  if (model === undefined) {
    throw new RelayHttpError({
      status: 400,
      message: `The model \`${value.slice(0, 64)}\` does not exist on this relay. Use \`claude-relay-default\`.`,
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    });
  }
  return model;
}
