import { writable } from 'svelte/store';

export interface AuthStatus {
  enabled: boolean;
  loggedIn: boolean;
  username?: string;
  expiresAt?: string;
}

export type AuthPhase = 'loading' | 'authenticated' | 'anonymous' | 'disabled' | 'error';
export interface AuthState extends AuthStatus {
  phase: AuthPhase;
  error?: string;
}

export const authState = writable<AuthState>({ phase: 'loading', enabled: true, loggedIn: false });

const unauthorizedListeners = new Set<() => void>();

async function authRequest(path: string, init: RequestInit = {}): Promise<AuthStatus> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    let message = response.status === 401 ? '用户名或密码错误' : '认证服务暂时不可用';
    try {
      const body = await response.json() as { error?: string };
      if (body.error && response.status !== 401) message = body.error;
    } catch { /* use the status-based message */ }
    throw new Error(message);
  }
  return response.json() as Promise<AuthStatus>;
}

export function getAuthStatus(): Promise<AuthStatus> {
  return authRequest('/api/auth/status');
}

export function login(username: string, password: string): Promise<AuthStatus> {
  return authRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function logout(): Promise<void> {
  await authRequest('/api/auth/logout', { method: 'POST' });
  requireLogin();
}

export function requireLogin(): void {
  let notify = false;
  authState.update((current) => {
    notify = current.phase !== 'anonymous';
    return { phase: 'anonymous', enabled: true, loggedIn: false };
  });
  if (notify) unauthorizedListeners.forEach((listener) => listener());
}

export function subscribeUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}
