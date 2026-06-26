export type QueryValue = string | null | undefined;

export function currentQueryParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

export function updateQueryParams(values: Record<string, QueryValue>, replace = false): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    const trimmed = value?.trim();
    if (trimmed) {
      url.searchParams.set(key, trimmed);
    } else {
      url.searchParams.delete(key);
    }
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    (replace ? history.replaceState : history.pushState).call(history, {}, '', next);
  }
}
