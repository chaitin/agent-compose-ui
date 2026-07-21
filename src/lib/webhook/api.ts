import { authFetch } from '../auth-fetch';
import type { PublishResponse, WebhookSource, WebhookSourceRequest } from './types';

export class WebhookApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
    this.name = 'WebhookApiError';
  }
}

async function parseError(response: Response): Promise<WebhookApiError> {
  let message = `请求失败 (${response.status})`;
  let details: unknown;
  try {
    const text = await response.text();
    if (text) {
      try {
        const body = JSON.parse(text) as { error?: string; message?: string } | string;
        if (typeof body === 'string') {
          message = body;
        } else if (body?.error) {
          message = body.error;
          details = body;
        } else if (body?.message) {
          message = body.message;
          details = body;
        }
      } catch {
        message = text;
      }
    }
  } catch {
    // ignore body parse errors
  }
  return new WebhookApiError(response.status, message, details);
}

export const webhookApi = {
  async listSources(signal?: AbortSignal): Promise<WebhookSource[]> {
    let response: Response;
    try {
      response = await authFetch('/api/webhook-sources', { signal });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new WebhookApiError(0, 'daemon 不可达，请检查服务状态', error);
    }
    if (!response.ok) throw await parseError(response);
    const body = (await response.json()) as { items: WebhookSource[] };
    return body.items ?? [];
  },

  async upsertSource(req: WebhookSourceRequest): Promise<WebhookSource> {
    const { id, ...body } = req;
    let response: Response;
    try {
      response = await authFetch(`/api/webhook-sources/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new WebhookApiError(0, 'daemon 不可达，请检查服务状态', error);
    }
    if (!response.ok) throw await parseError(response);
    const result = (await response.json()) as { source: WebhookSource };
    return result.source;
  },

  async deleteSource(id: string): Promise<void> {
    let response: Response;
    try {
      response = await authFetch(`/api/webhook-sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new WebhookApiError(0, 'daemon 不可达，请检查服务状态', error);
    }
    if (response.status === 204) return;
    if (!response.ok) throw await parseError(response);
  },

  async publishEvent(topic: string, token: string, body: unknown): Promise<PublishResponse> {
    let response: Response;
    try {
      response = await fetch(`/api/webhooks/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new WebhookApiError(0, '网络错误，请检查 daemon 是否在线', error);
    }
    const text = await response.text();
    if (!response.ok) {
      let message = `请求失败 (${response.status})`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed?.error) message = parsed.error;
      } catch {
        // ignore
      }
      throw new WebhookApiError(response.status, message);
    }
    return JSON.parse(text) as PublishResponse;
  },
};
