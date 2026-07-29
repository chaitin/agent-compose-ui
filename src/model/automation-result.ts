export type AutomationResult = {
  output: string;
  sandboxId: string;
  cellId: string;
  success?: boolean;
  exitCode?: number;
  raw: string;
};

type JsonObject = Record<string, unknown>;

export function parseAutomationResult(value: string): AutomationResult {
  const raw = value.trim();
  if (!raw) return { output: '', sandboxId: '', cellId: '', raw: '' };
  try {
    const result = JSON.parse(raw) as JsonObject;
    return {
      output: firstString(result.output, result.finalText, result.text, result.stdout),
      sandboxId: stringValue(result.sandboxId),
      cellId: stringValue(result.cellId),
      success: booleanValue(result.success),
      exitCode: numberValue(result.exitCode),
      raw: JSON.stringify(result, null, 2),
    };
  } catch {
    return { output: raw, sandboxId: '', cellId: '', raw };
  }
}

function firstString(...values: unknown[]): string {
  return values.find((item): item is string => typeof item === 'string' && item.trim().length > 0) ?? '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
