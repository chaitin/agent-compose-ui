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
    throw new Error(response.status === 401 ? '用户名或密码错误' : '认证服务暂时不可用');
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error('认证服务返回了无效响应'); }
  if (!isAuthStatus(body)) throw new Error('认证服务返回了无效响应');
  return body;
}

function isAuthStatus(value: unknown): value is AuthStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.enabled === 'boolean'
    && typeof candidate.loggedIn === 'boolean'
    && (candidate.username === undefined || typeof candidate.username === 'string')
    && (candidate.expiresAt === undefined || typeof candidate.expiresAt === 'string');
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
