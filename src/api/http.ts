// Generic helper for the backend's plain HTTP endpoints (non-Connect),
// e.g. /api/auth/* and /api/agent-compose/workspaces/*. Connect RPCs use client.ts.

import { apiPath } from '../paths';

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
  if (!isFormData && init.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(apiPath(path), { credentials: 'same-origin', ...init, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let messageText = text;
    try {
      messageText = (JSON.parse(text) as { error?: string })?.error ?? text;
    } catch {
      // body was not JSON; keep raw text
    }
    throw new Error(messageText || `请求失败：${response.status}`);
  }
  return response;
}

export async function apiFetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  return (await response.json()) as T;
}
