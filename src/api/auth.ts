import { apiFetchJson } from './http';

// Login/auth state from the agent-compose-ui server. Auth is enabled via the
// UI-side AUTH_* / OAUTH_* env at deploy time; there is no RPC to change it,
// so the settings UI shows this read-only.
export type AuthStatus = {
  enabled: boolean;
  loggedIn: boolean;
  oauthEnabled: boolean;
  username: string;
  expiresAt: string;
  user?: AuthUser;
};

export type AuthUser = { id: string; source: string; username: string; displayName: string; authMethod: string };

type RawAuthStatus = Partial<Omit<AuthStatus, 'user'>> & { user?: Partial<AuthUser> };

function authStatus(response: RawAuthStatus): AuthStatus {
  const username = response.username ?? response.user?.username ?? '';
  return {
    enabled: Boolean(response.enabled),
    loggedIn: Boolean(response.loggedIn),
    oauthEnabled: Boolean(response.oauthEnabled),
    username,
    expiresAt: response.expiresAt ?? '',
    user: response.user?.id
      ? {
          id: response.user.id,
          source: response.user.source ?? '',
          username: response.user.username ?? username,
          displayName: response.user.displayName ?? username,
          authMethod: response.user.authMethod ?? '',
        }
      : undefined,
  };
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return authStatus(await apiFetchJson<RawAuthStatus>('/api/auth/status'));
}

export async function loginWithPassword(username: string, password: string): Promise<AuthStatus> {
  const response = await apiFetchJson<RawAuthStatus>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  return authStatus(response);
}

export async function logout(): Promise<void> {
  await apiFetchJson<{ loggedIn?: boolean }>('/api/auth/logout', { method: 'POST' });
}
