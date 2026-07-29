export type TextMatch = { start: number; end: number };

export function literalTextMatches(text: string, query: string): TextMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const haystack = text.toLocaleLowerCase();
  const matches: TextMatch[] = [];
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, offset);
    if (start < 0) break;
    matches.push({ start, end: start + needle.length });
    offset = start + Math.max(needle.length, 1);
  }
  return matches;
}

export function textMatchCount(text: string, query: string): number {
  return literalTextMatches(text, query).length;
}

export function textMatchOffsets(
  entries: Array<{ key: string; text: string }>,
  query: string,
): { offsets: Map<string, number>; total: number } {
  const offsets = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    offsets.set(entry.key, total);
    total += textMatchCount(entry.text, query);
  }
  return { offsets, total };
}
