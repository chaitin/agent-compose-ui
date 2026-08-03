export function compactIdentifier(value: string, prefixLength = 12, suffixLength = 4): string {
  const normalized = value.trim();
  if (!/^[a-f\d]{32,}$/i.test(normalized)) return value;
  return `${normalized.slice(0, prefixLength)}…${normalized.slice(-suffixLength)}`;
}
