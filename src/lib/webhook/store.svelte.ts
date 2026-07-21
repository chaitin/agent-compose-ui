import { webhookApi } from './api';
import { WebhookApiError } from './api';
import type { WebhookSource } from './types';

class WebhookStore {
  sources = $state<WebhookSource[]>([]);
  loading = $state(false);
  lastError = $state<WebhookApiError | null>(null);
  selectedSourceId = $state<string | null>(null);
  sessionTokens = new Map<string, string>();

  async loadSources(): Promise<void> {
    this.loading = true;
    try {
      const items = await webhookApi.listSources();
      this.sources = items;
      this.lastError = null;
      if (!items.some((s) => s.id === this.selectedSourceId)) {
        this.selectedSourceId = items[0]?.id ?? null;
      }
    } catch (error) {
      const wrapped = error instanceof WebhookApiError
        ? error
        : new WebhookApiError(0, error instanceof Error ? error.message : String(error));
      this.lastError = wrapped;
    } finally {
      this.loading = false;
    }
  }

  selectSource(id: string): void {
    this.selectedSourceId = id;
  }

  async upsert(req: Parameters<typeof webhookApi.upsertSource>[0]): Promise<WebhookSource> {
    const source = await webhookApi.upsertSource(req);
    if (req.token) {
      this.sessionTokens.set(source.id, req.token);
    }
    await this.loadSources();
    return source;
  }

  async remove(id: string): Promise<void> {
    await webhookApi.deleteSource(id);
    this.sessionTokens.delete(id);
    await this.loadSources();
  }
}

export const webhookStore = new WebhookStore();
