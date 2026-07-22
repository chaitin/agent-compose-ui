export type ApiTokenRole = 'admin' | 'read-only-admin';

export interface ApiTokenMetadata {
  id: string;
  name: string;
  role: ApiTokenRole;
  createdAt: string;
  revokedAt?: string;
}

export interface CreatedApiToken extends ApiTokenMetadata {
  token: string;
}

export class ApiTokenError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiTokenError';
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...init.headers },
    });
  } catch (cause) {
    throw new ApiTokenError(0, cause instanceof Error ? cause.message : 'Token 服务不可达');
  }
  if (response.ok) return response;
  let message = response.status === 503 ? 'Token 管理功能未启用' : `请求失败 (${response.status})`;
  try {
    const body = await response.json() as { error?: string; message?: string };
    message = body.error ?? body.message ?? message;
  } catch {
    // Keep the status-derived message for non-JSON gateway responses.
  }
  throw new ApiTokenError(response.status, message);
}

export const apiTokens = {
  async list(): Promise<ApiTokenMetadata[]> {
    const response = await request('/ui-api/v1/tokens');
    const body = await response.json() as { items?: ApiTokenMetadata[] };
    return Array.isArray(body.items) ? body.items : [];
  },

  async create(name: string, role: ApiTokenRole): Promise<CreatedApiToken> {
    const response = await request('/ui-api/v1/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role }),
    });
    return await response.json() as CreatedApiToken;
  },

  async revoke(id: string): Promise<void> {
    await request(`/ui-api/v1/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};
