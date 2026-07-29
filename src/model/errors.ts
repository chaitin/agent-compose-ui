const MAX_SUMMARY_LENGTH = 240;

export function failureSummary(...values: Array<string | undefined>): string {
  const firstLine = values
    .flatMap((value) => (value || '').split('\n'))
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return '执行失败';
  const withoutUrl = firstLine.replace(/,?\s+url:\s+.*$/i, '').trim();
  return withoutUrl.length > MAX_SUMMARY_LENGTH ? `${withoutUrl.slice(0, MAX_SUMMARY_LENGTH).trimEnd()}…` : withoutUrl;
}

export function failureDetails(...values: Array<string | undefined>): string {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].join(
    '\n\n',
  );
}
