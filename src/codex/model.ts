export const CODEX_DEFAULT_MODEL_LABEL = "Codex default";
export const CODEX_DEFAULT_MODEL_SENTINEL = "__CODEX_DEFAULT__";

const CODEX_DEFAULT_MODEL_ALIAS = "default";

function normalizeModelValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseConfiguredModel(value: string | undefined): string | undefined {
  const model = normalizeModelValue(value);
  if (!model) return undefined;
  return model.toLowerCase() === CODEX_DEFAULT_MODEL_ALIAS ? undefined : model;
}

export function parseProjectModelInput(value: string | null | undefined): string | undefined {
  const model = normalizeModelValue(value);
  if (!model) return undefined;
  return model.toLowerCase() === CODEX_DEFAULT_MODEL_ALIAS
    ? CODEX_DEFAULT_MODEL_SENTINEL
    : model;
}

export function resolveModelSelection(
  selection: string | null | undefined,
  defaultModel?: string,
): string | undefined {
  if (selection === CODEX_DEFAULT_MODEL_SENTINEL) {
    return undefined;
  }
  return normalizeModelValue(selection) ?? defaultModel;
}

export function formatModelSelection(
  selection: string | null | undefined,
  defaultModel?: string,
): string {
  if (selection === CODEX_DEFAULT_MODEL_SENTINEL) {
    return CODEX_DEFAULT_MODEL_LABEL;
  }
  return normalizeModelValue(selection) ?? defaultModel ?? CODEX_DEFAULT_MODEL_LABEL;
}

export function discoveredSessionModelSelection(model: string | undefined): string {
  return parseProjectModelInput(model) ?? CODEX_DEFAULT_MODEL_SENTINEL;
}
