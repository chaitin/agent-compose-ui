# Webhook Source Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Webhooks tab to system settings that lets developers register/manage/test webhook sources via the existing backend REST API.

**Architecture:** Follow the workspace feature's structure (`src/lib/workspace/` + `src/components/workspace/`). A thin REST client (`src/lib/webhook/api.ts`) wraps `authFetch`; a rune-based store (`src/lib/webhook/store.svelte.ts`) holds the sources list plus an in-memory `sessionTokens` Map for plaintext tokens. Four Svelte components sit under `src/components/settings/`: `WebhookPanel` (container), `WebhookSourceTable`, `WebhookRegisterModal`, `WebhookCurlPreview`. Add `'webhooks'` to the existing `Page` union and a new tab in `SystemSettings.svelte`.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest + @testing-library/svelte, Bun test, Connect RPC (untouched, we use REST), existing `authFetch`.

## Global Constraints

- Frontend-only. Do not modify `agent-compose/` backend code; the REST API in `pkg/events/webhooks/http.go` is the contract.
- v1 scope is fixed in `docs/superpowers/specs/2026-07-21-webhook-source-management-design.md` §2. Do not add live request log, source editing, or provider/signature fields.
- `sessionTokens` Map must never be persisted to localStorage/sessionStorage/cookie. Page refresh = empty Map (by design).
- Topic prefix must match `^webhook\.[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*\.$` (client-side pre-validation, aligned with backend `topic_event_store.go:766-772`).
- Test requests `POST /api/webhooks/:topic` use plain `fetch` (NOT `authFetch`) because that endpoint is exempt from daemon auth (`daemon_auth.go:65`). All other requests use `authFetch`.
- Do not commit or push without explicit user authorization.
- Test commands: `bun test <path>` for unit tests, `bunx vitest run <path>` for component tests, `bun run check` for svelte-check.
- Token format: `'tok_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)` (28 chars total).

---

### Task 1: Types + API client + store (no UI)

**Files:**
- Create: `src/lib/webhook/types.ts`
- Create: `src/lib/webhook/api.ts`
- Create: `src/lib/webhook/store.svelte.ts`
- Test: `src/lib/webhook/api.test.ts`
- Test: `src/lib/webhook/store.test.ts`

**Interfaces:**
- Produces: `WebhookSource` and `WebhookSourceRequest` types; `webhookApi.listSources()`, `webhookApi.upsertSource(req)`, `webhookApi.deleteSource(id)`, `webhookApi.publishEvent(topic, token, body)`; `WebhookApiError` class; `webhookStore` singleton with `sources`, `loading`, `loadSources()`, `sessionTokens` Map, `selectedSourceId`, `selectSource(id)`.
- Consumes: `authFetch` from `src/lib/auth-fetch.ts`.

- [ ] **Step 1: Write the failing test for types and API client**

Create `src/lib/webhook/api.test.ts`:

```ts
import { afterEach, expect, test, vi } from 'vitest';
import { webhookApi, WebhookApiError } from './api';
import type { WebhookSource } from './types';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../auth-fetch', () => ({
  authFetch: (...args: unknown[]) => fetchMock(...args),
}));

afterEach(() => fetchMock.mockReset());

const sampleSource: WebhookSource = {
  id: 'src_001',
  name: 'siem-alert',
  enabled: true,
  provider: 'generic',
  topic_prefix: 'webhook.siem.alert.',
  has_token: true,
  has_signature_secret: false,
  body_limit_bytes: 0,
  created_at: '2026-07-21T14:00:00Z',
  updated_at: '2026-07-21T14:00:00Z',
};

test('listSources calls GET /api/webhook-sources and returns items', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ items: [sampleSource] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  const result = await webhookApi.listSources();
  expect(fetchMock).toHaveBeenCalledWith('/api/webhook-sources', expect.anything());
  expect(result).toEqual([sampleSource]);
});

test('upsertSource calls PUT /api/webhook-sources/:id with JSON body', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ source: sampleSource }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  const result = await webhookApi.upsertSource({
    id: 'src_001',
    name: 'siem-alert',
    enabled: true,
    provider: 'generic',
    topic_prefix: 'webhook.siem.alert.',
    token: 'tok_abc',
  });
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/webhook-sources/src_001',
    expect.objectContaining({ method: 'PUT', body: expect.stringContaining('"token":"tok_abc"') }),
  );
  expect(result).toEqual(sampleSource);
});

test('deleteSource calls DELETE and resolves on 204', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await webhookApi.deleteSource('src_001');
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/webhook-sources/src_001',
    expect.objectContaining({ method: 'DELETE' }),
  );
});

test('publishEvent uses plain fetch (not authFetch) with Bearer token', async () => {
  const plainFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({ accepted: true, topic: 'webhook.siem.alert', event_id: 'evt_x', sequence: 1, correlation_id: 'evt_x' }), { status: 202 }),
  );
  const result = await webhookApi.publishEvent('webhook.siem.alert', 'tok_abc', { test: true });
  expect(plainFetch).toHaveBeenCalledWith(
    '/api/webhooks/webhook.siem.alert',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Authorization': 'Bearer tok_abc',
        'Content-Type': 'application/json',
      }),
    }),
  );
  expect(result.event_id).toBe('evt_x');
  plainFetch.mockRestore();
});

test('error response is parsed into WebhookApiError', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'topic prefix is invalid' }), { status: 400, headers: { 'content-type': 'application/json' } }),
  );
  await expect(webhookApi.listSources()).rejects.toMatchObject({
    status: 400,
    message: 'topic prefix is invalid',
  });
  try {
    await webhookApi.listSources();
  } catch (e) {
    expect(e).toBeInstanceOf(WebhookApiError);
  }
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `bunx vitest run src/lib/webhook/api.test.ts`

Expected: FAIL — `Cannot find module './api'` or similar.

- [ ] **Step 3: Create types.ts**

Create `src/lib/webhook/types.ts`:

```ts
export interface WebhookSource {
  id: string;
  name: string;
  enabled: boolean;
  provider: string;
  topic_prefix: string;
  has_token: boolean;
  token_header?: string;
  signature_type?: string;
  has_signature_secret: boolean;
  body_limit_bytes?: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookSourceRequest {
  id: string;
  name: string;
  enabled?: boolean;
  provider: string;
  topic_prefix: string;
  token?: string;
  token_hash?: string;
  token_header?: string;
  clear_token?: boolean;
  signature_type?: string;
  signature_secret?: string;
  clear_signature?: boolean;
  body_limit_bytes?: number;
}

export interface PublishResponse {
  accepted: boolean;
  topic: string;
  event_id: string;
  sequence: number;
  correlation_id: string;
}

export type TestPhase = 'idle' | 'sending' | 'success' | 'error';

export interface TestState {
  phase: Exclude<TestPhase, 'idle'>;
  status?: number;
  eventId?: string;
  sequence?: number;
  message?: string;
  at: number;
}
```

- [ ] **Step 4: Create api.ts**

Create `src/lib/webhook/api.ts`:

```ts
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
```

- [ ] **Step 5: Run the API test to verify GREEN**

Run: `bunx vitest run src/lib/webhook/api.test.ts`

Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing test for the store**

Create `src/lib/webhook/store.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest';
import { webhookStore } from './store.svelte';
import { WebhookApiError } from './api';
import type { WebhookSource } from './types';

const apiMock = vi.hoisted(() => ({
  listSources: vi.fn(),
  upsertSource: vi.fn(),
  deleteSource: vi.fn(),
}));
vi.mock('./api', () => ({ webhookApi: apiMock }));

beforeEach(() => {
  vi.clearAllMocks();
  webhookStore.sources = [];
  webhookStore.loading = false;
  webhookStore.lastError = null;
  webhookStore.selectedSourceId = null;
  webhookStore.sessionTokens.clear();
});

const sourceA: WebhookSource = {
  id: 'a', name: 'alpha', enabled: true, provider: 'generic',
  topic_prefix: 'webhook.alpha.', has_token: true, has_signature_secret: false,
  body_limit_bytes: 0, created_at: '2026-07-21T10:00:00Z', updated_at: '2026-07-21T10:00:00Z',
};

const sourceB: WebhookSource = {
  ...sourceA, id: 'b', name: 'beta', topic_prefix: 'webhook.beta.',
};

test('loadSources populates sources and selects first by default', async () => {
  apiMock.listSources.mockResolvedValueOnce([sourceA, sourceB]);
  await webhookStore.loadSources();
  expect(webhookStore.sources).toEqual([sourceA, sourceB]);
  expect(webhookStore.selectedSourceId).toBe('a');
  expect(webhookStore.loading).toBe(false);
  expect(webhookStore.lastError).toBe(null);
});

test('loadSources stores error on failure', async () => {
  apiMock.listSources.mockRejectedValueOnce(new WebhookApiError(500, 'boom'));
  await webhookStore.loadSources();
  expect(webhookStore.sources).toEqual([]);
  expect(webhookStore.lastError).toBeInstanceOf(WebhookApiError);
  expect(webhookStore.lastError?.message).toBe('boom');
});

test('loadSources preserves selectedSourceId if still present', async () => {
  webhookStore.selectedSourceId = 'b';
  apiMock.listSources.mockResolvedValueOnce([sourceA, sourceB]);
  await webhookStore.loadSources();
  expect(webhookStore.selectedSourceId).toBe('b');
});

test('loadSources falls back to first if previous selection is gone', async () => {
  webhookStore.selectedSourceId = 'gone';
  apiMock.listSources.mockResolvedValueOnce([sourceA, sourceB]);
  await webhookStore.loadSources();
  expect(webhookStore.selectedSourceId).toBe('a');
});

test('selectSource updates selectedSourceId', () => {
  webhookStore.sources = [sourceA, sourceB];
  webhookStore.selectSource('b');
  expect(webhookStore.selectedSourceId).toBe('b');
});

test('sessionTokens map is in-memory only', () => {
  webhookStore.sessionTokens.set('a', 'tok_xyz');
  expect(webhookStore.sessionTokens.get('a')).toBe('tok_xyz');
  webhookStore.sessionTokens.delete('a');
  expect(webhookStore.sessionTokens.get('a')).toBe(undefined);
});
```

- [ ] **Step 7: Run the store test to verify RED**

Run: `bunx vitest run src/lib/webhook/store.test.ts`

Expected: FAIL — `Cannot find module './store.svelte'`.

- [ ] **Step 8: Create store.svelte.ts**

Create `src/lib/webhook/store.svelte.ts`:

```ts
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
```

- [ ] **Step 9: Run all webhook tests and verify GREEN**

Run: `bunx vitest run src/lib/webhook/`

Expected: PASS (11 tests across 2 files).

- [ ] **Step 10: Commit**

```bash
git add src/lib/webhook/
git commit -m "feat(webhook): add types, REST client, and store"
```

---

### Task 2: Page type + route + empty panel

**Files:**
- Modify: `src/lib/stores.svelte.ts` (Page union, buildHash, parseHash)
- Modify: `src/pages/SystemSettings.svelte` (add tab + module)
- Create: `src/components/settings/WebhookPanel.svelte` (empty shell)
- Test: `src/pages/SystemSettings.test.ts` (extend if exists, otherwise create)

**Interfaces:**
- Produces: `'webhooks'` value in `Page` union; `WebhookPanel` Svelte component (empty placeholder for now).
- Consumes: existing `store` from `src/lib/stores.svelte.ts`.

- [ ] **Step 1: Write the failing test for routing**

Check if `src/pages/SystemSettings.test.ts` exists; if not, create it. Add:

```ts
import { describe, expect, test } from 'vitest';
import { store } from '../lib/stores.svelte';

describe('webhook routing', () => {
  test('Page type includes webhooks', () => {
    store.goTo('webhooks');
    expect(store.currentPage).toBe('webhooks');
  });

  test('buildHash produces #/system/webhooks', () => {
    store.goTo('webhooks');
    const hash = store.currentHash();
    expect(hash).toBe('#/system/webhooks');
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `bunx vitest run src/pages/SystemSettings.test.ts`

Expected: FAIL — `webhooks` not assignable to `Page`, or `currentPage` does not become `'webhooks'`.

- [ ] **Step 3: Add 'webhooks' to Page union and routing**

Modify `src/lib/stores.svelte.ts`:

Find the `Page` type (around line 1) and add `'webhooks'`:

```ts
export type Page = 'dashboard' | 'project' | 'images' | 'environment' | 'caches' | 'volumes' | 'settings' | 'webhooks' | 'session-detail';
```

Find the `parseHash` function (around line 172). Add handling for `webhooks`:

```ts
const page = ({ images: 'images', environment: 'environment', capabilities: 'settings', webhooks: 'webhooks' } as const)[segments[1]];
```

Find `buildHash` (around line 377). Add the webhooks branch:

```ts
if (page === 'settings') return '#/system/capabilities';
if (page === 'images') return '#/system/images';
if (page === 'environment') return '#/system/environment';
if (page === 'webhooks') return '#/system/webhooks';
```

- [ ] **Step 4: Run the test to verify GREEN**

Run: `bunx vitest run src/pages/SystemSettings.test.ts`

Expected: PASS.

- [ ] **Step 5: Create empty WebhookPanel**

Create `src/components/settings/WebhookPanel.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { webhookStore } from '../../lib/webhook/store.svelte';

  onMount(() => {
    webhookStore.loadSources();
  });
</script>

<div class="webhook-panel">
  <header class="page-heading">
    <h2>Webhook 源</h2>
    <p>注册外部系统向 daemon 推送事件的入口。每个源绑定一个 topic 前缀和访问 token。</p>
  </header>
  {#if webhookStore.loading}
    <div class="loading">加载中...</div>
  {:else if webhookStore.lastError}
    <div class="error">
      加载失败：{webhookStore.lastError.message}
      <button onclick={() => webhookStore.loadSources()}>重试</button>
    </div>
  {:else}
    <div class="placeholder">（待实现）</div>
  {/if}
</div>

<style>
  .webhook-panel { display: flex; flex-direction: column; gap: 16px; }
  .page-heading h2 { margin: 0 0 4px; font-size: var(--font-size-3xl); font-weight: 600; }
  .page-heading p { margin: 0; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .loading, .error, .placeholder { padding: 24px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-secondary); }
</style>
```

- [ ] **Step 6: Add Webhooks tab to SystemSettings**

Modify `src/pages/SystemSettings.svelte`. Find the `modules` array (around line 14):

```ts
const modules: Array<{ id: 'images' | 'environment' | 'capabilities' | 'webhooks'; label: string; page: Page }> = [
  { id: 'images', label: '镜像', page: 'images' },
  { id: 'environment', label: '环境变量', page: 'environment' },
  { id: 'webhooks', label: 'Webhooks', page: 'webhooks' },
  { id: 'capabilities', label: '能力服务', page: 'settings' },
];
```

Update `activeModule` derived (around line 10):

```ts
let activeModule = $derived(
  store.currentPage === 'environment' ? 'environment'
  : store.currentPage === 'settings' ? 'capabilities'
  : store.currentPage === 'webhooks' ? 'webhooks'
  : 'images'
);
```

Add the import at top:

```ts
import WebhookPanel from '../components/settings/WebhookPanel.svelte';
```

Add the panel rendering branch (before the final `{:else}` for capabilities):

```svelte
{:else if activeModule === 'webhooks'}
  <div id="system-panel-webhooks" role="tabpanel" aria-labelledby="system-tab-webhooks" class="module-content webhook-module">
    <div class="module-heading"><p>注册外部事件入口，绑定 topic 前缀和访问 token</p></div>
    <div class="webhook-panel-wrapper"><WebhookPanel /></div>
  </div>
```

Add the wrapper style alongside existing `.environment-panel`:

```css
.webhook-panel-wrapper{width:100%}.webhook-module :global(.webhook-panel){border-radius:7px}
```

- [ ] **Step 7: Verify svelte-check passes**

Run: `bun run check`

Expected: 0 errors, 0 warnings (or only pre-existing ones).

- [ ] **Step 8: Commit**

```bash
git add src/lib/stores.svelte.ts src/pages/SystemSettings.svelte src/pages/SystemSettings.test.ts src/components/settings/WebhookPanel.svelte
git commit -m "feat(webhook): add Webhooks tab and empty panel"
```

---

### Task 3: WebhookPanel container + read-only table

**Files:**
- Modify: `src/components/settings/WebhookPanel.svelte`
- Create: `src/components/settings/WebhookSourceTable.svelte`
- Test: `src/components/settings/WebhookSourceTable.test.ts`

**Interfaces:**
- Produces: `WebhookSourceTable` component with prop `sources: WebhookSource[]` and event callbacks (not yet wired).
- Consumes: `webhookStore` from Task 1.

- [ ] **Step 1: Write the failing test for the table**

Create `src/components/settings/WebhookSourceTable.test.ts`:

```ts
import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import WebhookSourceTable from './WebhookSourceTable.svelte';
import type { WebhookSource } from '../../lib/webhook/types';

const baseSource: WebhookSource = {
  id: 'a', name: 'siem-alert', enabled: true, provider: 'generic',
  topic_prefix: 'webhook.siem.alert.', has_token: true, has_signature_secret: false,
  body_limit_bytes: 0, created_at: '2026-07-21T10:00:00Z', updated_at: '2026-07-21T10:00:00Z',
};

test('renders header row with all columns', () => {
  render(WebhookSourceTable, { props: { sources: [], sessionTokenIds: new Set<string>(), selectedSourceId: null, testStates: new Map() } });
  expect(screen.getByText('名称')).toBeInTheDocument();
  expect(screen.getByText('Topic 前缀')).toBeInTheDocument();
  expect(screen.getByText('状态')).toBeInTheDocument();
  expect(screen.getByText('Token')).toBeInTheDocument();
  expect(screen.getByText('操作')).toBeInTheDocument();
});

test('renders empty state when sources is empty', () => {
  render(WebhookSourceTable, { props: { sources: [], sessionTokenIds: new Set<string>(), selectedSourceId: null, testStates: new Map() } });
  expect(screen.getByText('暂无 webhook 源')).toBeInTheDocument();
});

test('renders one row per source', () => {
  const sources = [
    baseSource,
    { ...baseSource, id: 'b', name: 'github-push', topic_prefix: 'webhook.github.', enabled: false },
  ];
  render(WebhookSourceTable, { props: { sources, sessionTokenIds: new Set<string>(['a']), selectedSourceId: 'a', testStates: new Map() } });
  expect(screen.getByText('siem-alert')).toBeInTheDocument();
  expect(screen.getByText('github-push')).toBeInTheDocument();
  expect(screen.getByText('webhook.siem.alert.')).toBeInTheDocument();
});

test('shows enabled pill for enabled source and disabled pill for disabled', () => {
  const sources = [
    baseSource,
    { ...baseSource, id: 'b', name: 'beta', topic_prefix: 'webhook.beta.', enabled: false },
  ];
  render(WebhookSourceTable, { props: { sources, sessionTokenIds: new Set<string>(), selectedSourceId: null, testStates: new Map() } });
  expect(screen.getByText('启用')).toBeInTheDocument();
  expect(screen.getByText('停用')).toBeInTheDocument();
});

test('shows session-available badge when sessionTokenIds has the id', () => {
  render(WebhookSourceTable, { props: { sources: [baseSource], sessionTokenIds: new Set<string>(['a']), selectedSourceId: 'a', testStates: new Map() } });
  expect(screen.getByText('会话内')).toBeInTheDocument();
});

test('shows needs-regen badge when sessionTokenIds does not have the id', () => {
  render(WebhookSourceTable, { props: { sources: [baseSource], sessionTokenIds: new Set<string>(), selectedSourceId: null, testStates: new Map() } });
  expect(screen.getByText('需重生成')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `bunx vitest run src/components/settings/WebhookSourceTable.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Create WebhookSourceTable.svelte (read-only)**

Create `src/components/settings/WebhookSourceTable.svelte`:

```svelte
<script lang="ts">
  import type { WebhookSource, TestState } from '../../lib/webhook/types';

  interface Props {
    sources: WebhookSource[];
    sessionTokenIds: Set<string>;
    selectedSourceId: string | null;
    testStates: Map<string, TestState>;
  }

  let { sources, sessionTokenIds, selectedSourceId, testStates }: Props = $props();
</script>

<div class="table-wrap">
  {#if sources.length === 0}
    <div class="empty-state">
      <div class="icon">⌥</div>
      <div class="title">暂无 webhook 源</div>
      <div class="hint">点击右上"+ 注册源"创建第一个源</div>
    </div>
  {:else}
    <table class="webhook-table">
      <thead>
        <tr>
          <th style="width: 16%;">名称</th>
          <th style="width: 24%;">Topic 前缀</th>
          <th style="width: 14%;">状态</th>
          <th style="width: 16%;">Token</th>
          <th style="width: 30%; text-align: right;">操作</th>
        </tr>
      </thead>
      <tbody>
        {#each sources as source (source.id)}
          <tr class="source-row" class:selected={selectedSourceId === source.id}>
            <td class="name">{source.name}</td>
            <td class="topic">{source.topic_prefix}</td>
            <td>
              <div class="status-cell">
                <span class="status-pill" class:enabled={source.enabled} class:disabled={!source.enabled}>
                  <span class="dot"></span>{source.enabled ? '启用' : '停用'}
                </span>
              </div>
            </td>
            <td>
              <div class="token-cell">
                <span class="dot" class:missing={!source.has_token}></span>
                <span>{source.has_token ? '已配置' : '未配置'}</span>
                {#if source.has_token}
                  <span class="session-badge" class:available={sessionTokenIds.has(source.id)} class:missing={!sessionTokenIds.has(source.id)}>
                    {sessionTokenIds.has(source.id) ? '会话内' : '需重生成'}
                  </span>
                {/if}
              </div>
            </td>
            <td>
              <div class="row-actions">
                <button type="button" disabled>📋 curl</button>
                <button type="button" disabled>⚡ 测试</button>
                <button type="button" disabled>↻ 重生成</button>
                <button type="button" class="danger" disabled>✕</button>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .table-wrap { width: 100%; }
  .webhook-table { width: 100%; border-collapse: collapse; font-size: var(--font-size-sm); }
  .webhook-table th {
    text-align: left; padding: 8px 16px; background: var(--bg-tertiary);
    color: var(--text-muted); font-weight: 600; font-size: var(--font-size-xs);
    text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border-color);
  }
  .webhook-table td { padding: 12px 16px; border-bottom: 1px solid var(--border-muted); vertical-align: middle; }
  .webhook-table tr.source-row:hover td { background: var(--bg-tertiary); }
  .webhook-table tr.source-row.selected td { background: color-mix(in srgb, var(--accent-blue) 6%, var(--bg-secondary)); }
  .webhook-table tr.source-row.selected td:first-child { box-shadow: inset 2px 0 0 var(--accent-blue); }
  .webhook-table .name { font-weight: 600; color: var(--text-primary); }
  .webhook-table .topic { font-family: var(--font-mono); color: var(--accent-blue); font-size: var(--font-size-xs); }

  .status-cell { display: flex; align-items: center; gap: 8px; }
  .status-pill {
    display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px;
    border-radius: 10px; font-size: 10px; font-weight: 600;
    font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.3px;
  }
  .status-pill.enabled { background: color-mix(in srgb, var(--accent-green) 15%, transparent); color: var(--accent-green); border: 1px solid color-mix(in srgb, var(--accent-green) 30%, transparent); }
  .status-pill.disabled { background: var(--bg-tertiary); color: var(--text-muted); border: 1px solid var(--border-color); }
  .status-pill .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }

  .token-cell { display: flex; align-items: center; gap: 6px; font-size: var(--font-size-xs); font-family: var(--font-mono); color: var(--text-secondary); }
  .token-cell .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-green); }
  .token-cell .dot.missing { background: var(--text-muted); }
  .token-cell .session-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; margin-left: 4px; }
  .token-cell .session-badge.available { color: var(--accent-green); background: color-mix(in srgb, var(--accent-green) 12%, transparent); }
  .token-cell .session-badge.missing { color: var(--accent-yellow); background: color-mix(in srgb, var(--accent-yellow) 12%, transparent); }

  .row-actions { display: flex; gap: 4px; justify-content: flex-end; }
  .row-actions button {
    padding: 4px 9px; border: 1px solid var(--border-color); border-radius: 3px;
    color: var(--text-secondary); font-size: var(--font-size-xs); background: var(--bg-secondary);
    display: flex; align-items: center; gap: 4px;
  }
  .row-actions button.danger { color: var(--text-secondary); }
  .row-actions button:disabled { opacity: 0.45; cursor: not-allowed; }

  .empty-state { padding: 48px 24px; text-align: center; color: var(--text-muted); }
  .empty-state .icon { font-size: 28px; opacity: 0.4; margin-bottom: 8px; }
  .empty-state .title { font-size: var(--font-size-md); color: var(--text-secondary); margin-bottom: 4px; }
  .empty-state .hint { font-size: var(--font-size-xs); }
</style>
```

- [ ] **Step 4: Run the table test to verify GREEN**

Run: `bunx vitest run src/components/settings/WebhookSourceTable.test.ts`

Expected: PASS (6 tests).

- [ ] **Step 5: Wire table into WebhookPanel**

Replace `src/components/settings/WebhookPanel.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { webhookStore } from '../../lib/webhook/store.svelte';
  import WebhookSourceTable from './WebhookSourceTable.svelte';
  import type { TestState } from '../../lib/webhook/types';

  let testStates = $state<Map<string, TestState>>(new Map());

  function sessionTokenIds(): Set<string> {
    return new Set(webhookStore.sessionTokens.keys());
  }

  onMount(() => {
    webhookStore.loadSources();
  });
</script>

<div class="webhook-panel">
  <header class="page-heading">
    <h2>Webhook 源</h2>
    <p>注册外部系统向 daemon 推送事件的入口。每个源绑定一个 topic 前缀和访问 token，YAML 里的 <code>scheduler.on("webhook.siem.alert", ...)</code> 通过 topic 匹配这些源。</p>
  </header>

  <section class="section-card">
    <header class="section-card-header">
      <div>
        <span class="title">已注册的源</span>
        <span class="desc">{webhookStore.sources.length} 个源 · {webhookStore.sources.filter(s => s.enabled).length} 启用</span>
      </div>
      <div class="spacer"></div>
      <button type="button" class="btn primary" disabled>+ 注册源</button>
    </header>
    {#if webhookStore.loading}
      <div class="loading">加载中...</div>
    {:else if webhookStore.lastError}
      <div class="error">
        加载失败：{webhookStore.lastError.message}
        <button type="button" onclick={() => webhookStore.loadSources()}>重试</button>
      </div>
    {:else}
      <WebhookSourceTable
        sources={webhookStore.sources}
        sessionTokenIds={sessionTokenIds()}
        selectedSourceId={webhookStore.selectedSourceId}
        {testStates}
      />
    {/if}
  </section>
</div>

<style>
  .webhook-panel { display: flex; flex-direction: column; gap: 16px; }
  .page-heading h2 { margin: 0 0 4px; font-size: var(--font-size-3xl); font-weight: 600; }
  .page-heading p { margin: 0; color: var(--text-secondary); font-size: var(--font-size-sm); max-width: 820px; line-height: 1.6; }
  .page-heading code { font-family: var(--font-mono); color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 10%, transparent); padding: 1px 5px; border-radius: 3px; font-size: 12px; }

  .section-card { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden; }
  .section-card-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border-color); background: var(--bg-tertiary); }
  .section-card-header .title { font-size: var(--font-size-md); font-weight: 600; }
  .section-card-header .desc { color: var(--text-muted); font-size: var(--font-size-xs); margin-left: 8px; }
  .section-card-header .spacer { flex: 1; }
  .section-card-header .btn { padding: 5px 12px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); font-size: var(--font-size-sm); }
  .section-card-header .btn.primary { background: var(--accent-green); color: #0d1117; border-color: var(--accent-green); font-weight: 600; }
  .section-card-header .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .loading, .error { padding: 24px; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .error button { margin-left: 12px; padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--bg-tertiary); color: var(--text-primary); font-size: var(--font-size-xs); }
</style>
```

- [ ] **Step 6: Verify svelte-check and tests**

Run:

```bash
bunx vitest run src/components/settings/WebhookSourceTable.test.ts src/pages/SystemSettings.test.ts
bun run check
```

Expected: all tests pass; svelte-check 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/WebhookPanel.svelte src/components/settings/WebhookSourceTable.svelte src/components/settings/WebhookSourceTable.test.ts
git commit -m "feat(webhook): render sources table (read-only)"
```

---

### Task 4: Register Modal

**Files:**
- Create: `src/components/settings/WebhookRegisterModal.svelte`
- Modify: `src/components/settings/WebhookPanel.svelte` (wire open button)
- Test: `src/components/settings/WebhookRegisterModal.test.ts`

**Interfaces:**
- Produces: `WebhookRegisterModal` component with `open: boolean` prop and `onclose: () => void` callback. Internally manages `view: 'form' | 'creating' | 'success'` state and writes to `webhookStore.sessionTokens` on success.
- Consumes: `webhookStore.upsert()` from Task 1.

- [ ] **Step 1: Write the failing test for the modal**

Create `src/components/settings/WebhookRegisterModal.test.ts`:

```ts
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WebhookRegisterModal from './WebhookRegisterModal.svelte';

const upsertMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/webhook/store.svelte', () => ({
  webhookStore: {
    upsert: upsertMock,
    sessionTokens: new Map(),
  },
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

test('shows form fields when open', () => {
  render(WebhookRegisterModal, { props: { open: true, onclose: () => {} } });
  expect(screen.getByText('注册 Webhook 源')).toBeInTheDocument();
  expect(screen.getByLabelText('名称')).toBeInTheDocument();
  expect(screen.getByLabelText('Topic 前缀')).toBeInTheDocument();
  expect(screen.getByText('访问 Token')).toBeInTheDocument();
  expect(screen.getByText('立即启用')).toBeInTheDocument();
});

test('disables register button when topic_prefix is invalid', async () => {
  render(WebhookRegisterModal, { props: { open: true, onclose: () => {} } });
  const topicInput = screen.getByLabelText('Topic 前缀');
  await fireEvent.input(topicInput, { target: { value: 'invalid-prefix' } });
  expect(screen.getByRole('button', { name: '注册' })).toBeDisabled();
});

test('enables register button when topic_prefix matches required format', async () => {
  render(WebhookRegisterModal, { props: { open: true, onclose: () => {} } });
  const nameInput = screen.getByLabelText('名称');
  const topicInput = screen.getByLabelText('Topic 前缀');
  await fireEvent.input(nameInput, { target: { value: 'siem-alert' } });
  await fireEvent.input(topicInput, { target: { value: 'webhook.siem.alert.' } });
  expect(screen.getByRole('button', { name: '注册' })).not.toBeDisabled();
});

test('on submit success, switches to success view showing token', async () => {
  upsertMock.mockResolvedValueOnce({ id: 'new-id', name: 'siem-alert', enabled: true, provider: 'generic', topic_prefix: 'webhook.siem.alert.', has_token: true, has_signature_secret: false, body_limit_bytes: 0, created_at: '', updated_at: '' });
  render(WebhookRegisterModal, { props: { open: true, onclose: () => {} } });
  await fireEvent.input(screen.getByLabelText('名称'), { target: { value: 'siem-alert' } });
  await fireEvent.input(screen.getByLabelText('Topic 前缀'), { target: { value: 'webhook.siem.alert.' } });
  await fireEvent.click(screen.getByRole('button', { name: '注册' }));
  await waitFor(() => {
    expect(screen.getByText('源已注册')).toBeInTheDocument();
  });
  expect(screen.getByText(/这是您最后一次能看到此 token/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '我已保存，关闭' })).toBeInTheDocument();
});

test('on submit failure, shows error in form view', async () => {
  const { WebhookApiError } = await import('../../lib/webhook/api');
  upsertMock.mockRejectedValueOnce(new WebhookApiError(400, 'topic prefix already exists'));
  render(WebhookRegisterModal, { props: { open: true, onclose: () => {} } });
  await fireEvent.input(screen.getByLabelText('名称'), { target: { value: 'siem-alert' } });
  await fireEvent.input(screen.getByLabelText('Topic 前缀'), { target: { value: 'webhook.siem.alert.' } });
  await fireEvent.click(screen.getByRole('button', { name: '注册' }));
  await waitFor(() => {
    expect(screen.getByText('topic prefix already exists')).toBeInTheDocument();
  });
  expect(screen.getByText('注册 Webhook 源')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `bunx vitest run src/components/settings/WebhookRegisterModal.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Create WebhookRegisterModal.svelte**

Create `src/components/settings/WebhookRegisterModal.svelte`:

```svelte
<script lang="ts">
  import { webhookStore } from '../../lib/webhook/store.svelte';
  import { WebhookApiError } from '../../lib/webhook/api';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();

  let view = $state<'form' | 'creating' | 'success'>('form');
  let name = $state('');
  let topicPrefix = $state('');
  let enabled = $state(true);
  let token = $state('');
  let submitError = $state<string | null>(null);
  let createdSourceId = $state<string | null>(null);

  const TOPIC_RE = /^webhook\.[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*\.$/;

  function generateToken(): string {
    return 'tok_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  }

  // Initialize token when modal opens
  $effect(() => {
    if (open && !token) {
      token = generateToken();
    }
    if (!open) {
      // Reset on close
      view = 'form';
      name = '';
      topicPrefix = '';
      enabled = true;
      token = '';
      submitError = null;
      createdSourceId = null;
    }
  });

  let topicValid = $derived(TOPIC_RE.test(topicPrefix));
  let nameValid = $derived(name.trim().length >= 1 && name.trim().length <= 64);
  let canSubmit = $derived(nameValid && topicValid && view === 'form');

  function regenToken(): void {
    token = generateToken();
  }

  async function copyToken(): Promise<void> {
    try {
      await navigator.clipboard.writeText(token);
    } catch {
      // ignore
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    view = 'creating';
    submitError = null;
    const sourceId = crypto.randomUUID();
    try {
      const source = await webhookStore.upsert({
        id: sourceId,
        name: name.trim(),
        enabled,
        provider: 'generic',
        topic_prefix: topicPrefix,
        token,
        signature_type: 'none',
      });
      createdSourceId = source.id;
      view = 'success';
    } catch (error) {
      submitError = error instanceof WebhookApiError ? error.message : String(error);
      view = 'form';
    }
  }

  function handleClose(): void {
    onclose();
  }
</script>

{#if open}
  <div class="modal-backdrop" onclick={(e) => { if (e.target === e.currentTarget && view !== 'creating') handleClose(); }}>
    <div class="modal" role="dialog" aria-modal="true">
      {#if view === 'form' || view === 'creating'}
        <header class="modal-header">
          <div class="title">注册 Webhook 源</div>
          <button type="button" class="close" onclick={handleClose} disabled={view === 'creating'}>×</button>
        </header>
        <div class="modal-body">
          {#if submitError}
            <div class="alert-banner error">{submitError}</div>
          {/if}
          <div class="field">
            <label for="wh-name">名称</label>
            <input id="wh-name" type="text" bind:value={name} placeholder="用于识别的显示名" />
            <div class="hint">在源列表里显示，可重复。仅作展示，不参与匹配。</div>
          </div>
          <div class="field" class:invalid={topicPrefix !== '' && !topicValid}>
            <label for="wh-topic">Topic 前缀</label>
            <input id="wh-topic" type="text" class="mono" bind:value={topicPrefix} placeholder="例如 webhook.siem.alert." />
            <div class="hint">YAML 里 <code>scheduler.on("webhook.siem.alert.*", ...)</code> 通过此 topic 匹配。必须以 <code>webhook.</code> 开头、<code>.</code> 结尾。</div>
            {#if topicPrefix !== '' && !topicValid}
              <div class="error-text">格式无效：必须形如 webhook.siem.alert.</div>
            {/if}
          </div>
          <div class="field">
            <label>访问 Token</label>
            <div class="token-input-group">
              <input type="text" value={token} readonly />
              <button type="button" onclick={regenToken}>↻ 重新生成</button>
              <button type="button" onclick={copyToken}>📋 复制</button>
            </div>
            <div class="hint">调用方在 <code>Authorization: Bearer &lt;token&gt;</code> 头里携带。<strong class="warn">仅在创建时显示一次，请立即保存。</strong></div>
          </div>
          <div class="toggle-row">
            <div class="toggle" class:on={enabled} onclick={() => enabled = !enabled} role="switch" aria-checked={enabled} tabindex="0"></div>
            <span class="toggle-label">立即启用<span class="sub">· 停用后所有发往此 topic 的请求返回 404</span></span>
          </div>
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn" onclick={handleClose} disabled={view === 'creating'}>取消</button>
          <button type="button" class="btn primary" onclick={handleSubmit} disabled={!canSubmit && view === 'form'}>
            {#if view === 'creating'}注册中...{:else}注册{/if}
          </button>
        </footer>
      {:else}
        <header class="modal-header">
          <span class="icon success">✓</span>
          <div class="title">源已注册</div>
          <button type="button" class="close" onclick={handleClose}>×</button>
        </header>
        <div class="modal-body">
          <div class="alert-banner warn">
            <span class="icon">⚠</span>
            <span>这是您最后一次能看到此 token。关闭后此 token 将不再显示，如需再次获取必须重新生成（会使旧 token 立即失效）。</span>
          </div>
          <div class="field">
            <label>访问 Token</label>
            <div class="token-display">
              <span class="value">{token}</span>
              <button type="button" onclick={copyToken}>📋 复制</button>
            </div>
          </div>
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn primary" onclick={handleClose}>我已保存，关闭</button>
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(1,4,9,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; backdrop-filter: blur(2px);
  }
  .modal {
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 8px; width: 520px; max-width: calc(100% - 32px);
    box-shadow: 0 16px 48px rgba(0,0,0,0.5);
  }
  .modal-header { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--border-color); }
  .modal-header .title { font-size: var(--font-size-xl); font-weight: 600; }
  .modal-header .icon.success { color: var(--accent-green); font-size: 18px; }
  .modal-header .close { margin-left: auto; color: var(--text-muted); font-size: 18px; padding: 4px; }
  .modal-header .close:hover { color: var(--text-primary); }
  .modal-body { padding: 16px 18px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: var(--font-size-xs); color: var(--text-secondary); margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
  .field .hint { color: var(--text-muted); font-size: var(--font-size-xs); margin-top: 4px; line-height: 1.5; }
  .field .hint code { font-family: var(--font-mono); color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 10%, transparent); padding: 1px 4px; border-radius: 2px; }
  .field .hint .warn { color: var(--accent-yellow); }
  .field .error-text { color: var(--accent-red); font-size: var(--font-size-xs); margin-top: 4px; }
  .field.invalid input { border-color: var(--accent-red); }
  .field input { width: 100%; padding: 5px 10px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-family: inherit; font-size: inherit; }
  .field input.mono { font-family: var(--font-mono); font-size: var(--font-size-xs); }
  .field input:focus { outline: 2px solid var(--accent-blue); outline-offset: -1px; border-color: var(--accent-blue); }

  .token-input-group { display: flex; gap: 6px; }
  .token-input-group input { flex: 1; font-family: var(--font-mono); font-size: var(--font-size-xs); padding: 5px 10px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; }
  .token-input-group button { padding: 0 12px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-size-xs); white-space: nowrap; }
  .token-input-group button:hover { color: var(--accent-blue); border-color: var(--accent-blue); }

  .toggle-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
  .toggle { width: 36px; height: 20px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 10px; position: relative; cursor: pointer; transition: background 0.15s; flex-shrink: 0; }
  .toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: var(--text-secondary); border-radius: 50%; transition: transform 0.15s, background 0.15s; }
  .toggle.on { background: color-mix(in srgb, var(--accent-green) 30%, var(--bg-tertiary)); border-color: var(--accent-green); }
  .toggle.on::after { transform: translateX(16px); background: var(--accent-green); }
  .toggle-label { font-size: var(--font-size-sm); color: var(--text-primary); }
  .toggle-label .sub { color: var(--text-muted); font-size: var(--font-size-xs); margin-left: 6px; }

  .modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border-color); background: var(--bg-tertiary); border-radius: 0 0 8px 8px; }
  .modal-footer .btn { padding: 6px 14px; border-radius: 4px; font-size: var(--font-size-sm); border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); }
  .modal-footer .btn:hover:not(:disabled) { border-color: var(--accent-blue); }
  .modal-footer .btn.primary { background: var(--accent-green); color: #0d1117; border-color: var(--accent-green); font-weight: 600; }
  .modal-footer .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .alert-banner { padding: 10px 12px; border-radius: 4px; margin-bottom: 14px; display: flex; gap: 8px; align-items: flex-start; font-size: var(--font-size-sm); line-height: 1.5; }
  .alert-banner.warn { background: color-mix(in srgb, var(--accent-yellow) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent-yellow) 35%, transparent); color: var(--accent-yellow); }
  .alert-banner.error { background: color-mix(in srgb, var(--accent-red) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent-red) 35%, transparent); color: var(--accent-red); }
  .alert-banner .icon { flex-shrink: 0; font-size: 14px; margin-top: 1px; }

  .token-display { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 4px; padding: 10px 12px; display: flex; align-items: center; gap: 8px; }
  .token-display .value { flex: 1; font-family: var(--font-mono); font-size: var(--font-size-xs); color: var(--accent-green); word-break: break-all; }
  .token-display button { padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-size-xs); }
  .token-display button:hover { color: var(--accent-blue); border-color: var(--accent-blue); }
</style>
```

- [ ] **Step 4: Run the modal test to verify GREEN**

Run: `bunx vitest run src/components/settings/WebhookRegisterModal.test.ts`

Expected: PASS (5 tests).

- [ ] **Step 5: Wire modal into WebhookPanel**

Modify `src/components/settings/WebhookPanel.svelte`. Add import and state at top of `<script>`:

```ts
  import WebhookRegisterModal from './WebhookRegisterModal.svelte';
  let registerOpen = $state(false);
```

Change the `+ 注册源` button:

```svelte
<button type="button" class="btn primary" onclick={() => registerOpen = true}>+ 注册源</button>
```

Add the modal at the bottom of the panel (before closing `</div>`):

```svelte
<WebhookRegisterModal open={registerOpen} onclose={() => registerOpen = false} />
```

- [ ] **Step 6: Verify svelte-check and tests**

Run:

```bash
bunx vitest run src/components/settings/WebhookRegisterModal.test.ts src/components/settings/WebhookSourceTable.test.ts
bun run check
```

Expected: all tests pass; svelte-check 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/WebhookRegisterModal.svelte src/components/settings/WebhookRegisterModal.test.ts src/components/settings/WebhookPanel.svelte
git commit -m "feat(webhook): add register modal with token generation"
```

---

### Task 5: Inline enable/disable toggle + delete

**Files:**
- Modify: `src/components/settings/WebhookSourceTable.svelte` (add toggle + delete actions)
- Modify: `src/components/settings/WebhookPanel.svelte` (wire callbacks, delete confirm)
- Test: `src/components/settings/WebhookSourceTable.test.ts` (extend)

**Interfaces:**
- Produces: `WebhookSourceTable` props gain `ontoggle: (id: string) => void`, `ondelete: (id: string) => void`, `onselect: (id: string) => void`, `oncopycurl: (id: string) => void` callbacks. Toggle now interactive.
- Consumes: `webhookStore` for upsert/delete.

- [ ] **Step 1: Extend the table test for toggle and delete**

Append to `src/components/settings/WebhookSourceTable.test.ts`:

```ts
import { fireEvent } from '@testing-library/svelte';

test('clicking row calls onselect with source id', async () => {
  const onselect = vi.fn();
  render(WebhookSourceTable, { props: { sources: [baseSource], sessionTokenIds: new Set(), selectedSourceId: null, testStates: new Map(), onselect, ontoggle: () => {}, ondelete: () => {}, oncopycurl: () => {}, ontest: () => {}, onregen: () => {} } });
  await fireEvent.click(screen.getByText('siem-alert'));
  expect(onselect).toHaveBeenCalledWith('a');
});

test('clicking toggle calls ontoggle with source id', async () => {
  const ontoggle = vi.fn();
  render(WebhookSourceTable, { props: { sources: [baseSource], sessionTokenIds: new Set(), selectedSourceId: null, testStates: new Map(), onselect: () => {}, ontoggle, ondelete: () => {}, oncopycurl: () => {}, ontest: () => {}, onregen: () => {} } });
  const toggle = container.querySelector('.mini-toggle');
  await fireEvent.click(toggle);
  expect(ontoggle).toHaveBeenCalledWith('a');
});
```

Add `container` to the render destructure where needed: `const { container } = render(...)`.

- [ ] **Step 2: Run the test to verify RED**

Run: `bunx vitest run src/components/settings/WebhookSourceTable.test.ts`

Expected: FAIL — `ontoggle` prop not implemented, `.mini-toggle` doesn't exist.

- [ ] **Step 3: Update WebhookSourceTable props and template**

Modify `src/components/settings/WebhookSourceTable.svelte`. Replace the `<script>` block with:

```ts
<script lang="ts">
  import type { WebhookSource, TestState } from '../../lib/webhook/types';

  interface Props {
    sources: WebhookSource[];
    sessionTokenIds: Set<string>;
    selectedSourceId: string | null;
    testStates: Map<string, TestState>;
    onselect: (id: string) => void;
    ontoggle: (id: string) => void;
    ondelete: (id: string) => void;
    oncopycurl: (id: string) => void;
    ontest: (id: string) => void;
    onregen: (id: string) => void;
  }

  let {
    sources,
    sessionTokenIds,
    selectedSourceId,
    testStates,
    onselect,
    ontoggle,
    ondelete,
    oncopycurl,
    ontest,
    onregen,
  }: Props = $props();
</script>
```

Update the status cell to add interactive toggle:

```svelte
<td>
  <div class="status-cell">
    <span class="status-pill" class:enabled={source.enabled} class:disabled={!source.enabled}>
      <span class="dot"></span>{source.enabled ? '启用' : '停用'}
    </span>
    <div class="mini-toggle" class:on={source.enabled} role="switch" aria-checked={source.enabled} tabindex="0"
         onclick={(e) => { e.stopPropagation(); ontoggle(source.id); }}
         onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); ontoggle(source.id); } }}>
    </div>
  </div>
</td>
```

Update the row `<tr>` to be clickable and the actions to be interactive:

```svelte
<tr class="source-row" class:selected={selectedSourceId === source.id}
    onclick={() => onselect(source.id)}>
```

Replace the disabled action buttons with wired ones:

```svelte
<td>
  <div class="row-actions">
    <button type="button" onclick={(e) => { e.stopPropagation(); oncopycurl(source.id); }}>📋 curl</button>
    <button type="button" disabled>⚡ 测试</button>
    <button type="button" onclick={(e) => { e.stopPropagation(); onregen(source.id); }}>↻ 重生成</button>
    <button type="button" class="danger" onclick={(e) => { e.stopPropagation(); ondelete(source.id); }}>✕</button>
  </div>
</td>
```

Add the mini-toggle style:

```css
.mini-toggle {
  width: 28px; height: 16px; background: var(--bg-tertiary);
  border: 1px solid var(--border-color); border-radius: 8px;
  position: relative; cursor: pointer; transition: background 0.15s; flex-shrink: 0;
}
.mini-toggle::after {
  content: ''; position: absolute; top: 1px; left: 1px;
  width: 12px; height: 12px; background: var(--text-secondary);
  border-radius: 50%; transition: transform 0.15s, background 0.15s;
}
.mini-toggle.on { background: color-mix(in srgb, var(--accent-green) 30%, var(--bg-tertiary)); border-color: var(--accent-green); }
.mini-toggle.on::after { transform: translateX(12px); background: var(--accent-green); }
.row-actions button:disabled { opacity: 0.45; cursor: not-allowed; }
.row-actions button:not(:disabled):hover { color: var(--accent-blue); border-color: var(--accent-blue); }
.row-actions button.danger:not(:disabled):hover { color: var(--accent-red); border-color: var(--accent-red); }
```

- [ ] **Step 4: Run the table tests to verify GREEN**

Run: `bunx vitest run src/components/settings/WebhookSourceTable.test.ts`

Expected: PASS (8 tests). The earlier 6 tests may need their props updated to include the new callbacks — update them to pass `() => {}` for each.

- [ ] **Step 5: Wire toggle and delete into WebhookPanel**

Modify `src/components/settings/WebhookPanel.svelte`. Add delete confirmation state and toggle/delete handlers:

```ts
let deleteTarget = $state<{ id: string; name: string } | null>(null);
let togglingId = $state<string | null>(null);

async function handleToggle(id: string): Promise<void> {
  const source = webhookStore.sources.find(s => s.id === id);
  if (!source) return;
  togglingId = id;
  try {
    await webhookStore.upsert({
      id: source.id,
      name: source.name,
      enabled: !source.enabled,
      provider: source.provider,
      topic_prefix: source.topic_prefix,
      signature_type: source.signature_type ?? 'none',
    });
  } catch (error) {
    console.error('toggle failed', error);
  } finally {
    togglingId = null;
  }
}

function handleDeleteRequest(id: string): void {
  const source = webhookStore.sources.find(s => s.id === id);
  if (!source) return;
  deleteTarget = { id, name: source.name };
}

async function handleDeleteConfirm(): Promise<void> {
  if (!deleteTarget) return;
  try {
    await webhookStore.remove(deleteTarget.id);
  } catch (error) {
    console.error('delete failed', error);
  } finally {
    deleteTarget = null;
  }
}
```

Pass callbacks to the table:

```svelte
<WebhookSourceTable
  sources={webhookStore.sources}
  sessionTokenIds={sessionTokenIds()}
  selectedSourceId={webhookStore.selectedSourceId}
  {testStates}
  onselect={(id) => webhookStore.selectSource(id)}
  ontoggle={handleToggle}
  ondelete={handleDeleteRequest}
  oncopycurl={(id) => { /* Task 7 */ }}
  ontest={(id) => { /* Task 6 */ }}
  onregen={(id) => { /* Task 8 */ }}
/>
```

Add delete confirmation modal at the bottom of the panel:

```svelte
{#if deleteTarget}
  <div class="modal-backdrop" onclick={(e) => { if (e.target === e.currentTarget) deleteTarget = null; }}>
    <div class="modal" role="dialog" aria-modal="true">
      <header class="modal-header">
        <span class="icon danger">⚠</span>
        <div class="title">删除 Webhook 源</div>
        <button type="button" class="close" onclick={() => deleteTarget = null}>×</button>
      </header>
      <div class="modal-body">
        <p>确定删除源 <code>{deleteTarget.name}</code>？此操作不可撤销。</p>
        <ul class="impact-list">
          <li>所有使用此源 token 的调用方将立即收到 401</li>
          <li>YAML 中 <code>scheduler.on("{deleteTarget.name}*", ...)</code> 的订阅将不再被触发</li>
          <li>已入库的历史事件保留，可通过 /api/events 查询</li>
        </ul>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn" onclick={() => deleteTarget = null}>取消</button>
        <button type="button" class="btn danger" onclick={handleDeleteConfirm}>删除</button>
      </footer>
    </div>
  </div>
{/if}
```

Add necessary styles for the modal (reuse from register modal — copy the `.modal-backdrop`, `.modal`, `.modal-header`, `.modal-body`, `.modal-footer`, `.btn` styles; add `.impact-list` style and `.icon.danger` color).

- [ ] **Step 6: Verify svelte-check and tests**

Run:

```bash
bunx vitest run src/components/settings/
bun run check
```

Expected: all tests pass; svelte-check 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/WebhookSourceTable.svelte src/components/settings/WebhookSourceTable.test.ts src/components/settings/WebhookPanel.svelte
git commit -m "feat(webhook): add toggle and delete actions"
```

---

### Task 6: Inline test + status bar

**Files:**
- Modify: `src/components/settings/WebhookSourceTable.svelte` (render test state bar, enable test button)
- Modify: `src/components/settings/WebhookPanel.svelte` (handle test request)
- Test: `src/components/settings/WebhookSourceTable.test.ts` (extend)

**Interfaces:**
- Produces: `WebhookSourceTable` `ontest` callback now fires; renders `.test-status-bar` for entries in `testStates`.
- Consumes: `webhookApi.publishEvent` via the panel.

- [ ] **Step 1: Extend the table test for test status bar**

Append to `src/components/settings/WebhookSourceTable.test.ts`:

```ts
test('renders test status bar when testStates has entry for source', () => {
  const testStates = new Map([
    ['a', { phase: 'success', status: 202, eventId: 'evt_abc', sequence: 5, at: Date.now() }],
  ]);
  render(WebhookSourceTable, {
    props: {
      sources: [baseSource],
      sessionTokenIds: new Set(['a']),
      selectedSourceId: 'a',
      testStates,
      onselect: () => {}, ontoggle: () => {}, ondelete: () => {},
      oncopycurl: () => {}, ontest: () => {}, onregen: () => {},
    },
  });
  expect(screen.getByText('202 Accepted')).toBeInTheDocument();
  expect(screen.getByText('evt_abc')).toBeInTheDocument();
});

test('test button is enabled when session has token and source is enabled', () => {
  render(WebhookSourceTable, {
    props: {
      sources: [baseSource],
      sessionTokenIds: new Set(['a']),
      selectedSourceId: 'a',
      testStates: new Map(),
      onselect: () => {}, ontoggle: () => {}, ondelete: () => {},
      oncopycurl: () => {}, ontest: () => {}, onregen: () => {},
    },
  });
  expect(screen.getByRole('button', { name: /⚡ 测试/ })).not.toBeDisabled();
});

test('test button is disabled when session has no token', () => {
  render(WebhookSourceTable, {
    props: {
      sources: [baseSource],
      sessionTokenIds: new Set(),
      selectedSourceId: null,
      testStates: new Map(),
      onselect: () => {}, ontoggle: () => {}, ondelete: () => {},
      oncopycurl: () => {}, ontest: () => {}, onregen: () => {},
    },
  });
  const btn = screen.getByRole('button', { name: /⚡ 测试/ });
  expect(btn).toBeDisabled();
  expect(btn.getAttribute('title')).toContain('需重新生成 token');
});

test('test button is disabled when source is disabled', () => {
  render(WebhookSourceTable, {
    props: {
      sources: [{ ...baseSource, enabled: false }],
      sessionTokenIds: new Set(['a']),
      selectedSourceId: null,
      testStates: new Map(),
      onselect: () => {}, ontoggle: () => {}, ondelete: () => {},
      oncopycurl: () => {}, ontest: () => {}, onregen: () => {},
    },
  });
  const btn = screen.getByRole('button', { name: /⚡ 测试/ });
  expect(btn).toBeDisabled();
  expect(btn.getAttribute('title')).toContain('源已停用');
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `bunx vitest run src/components/settings/WebhookSourceTable.test.ts`

Expected: FAIL — `.test-status-bar` doesn't render; test button still always disabled.

- [ ] **Step 3: Update WebhookSourceTable to enable test button and render status bar**

Modify `src/components/settings/WebhookSourceTable.svelte`. In the actions cell, replace the test button:

```svelte
{@const hasSessionToken = sessionTokenIds.has(source.id)}
{@const testDisabled = !hasSessionToken || !source.enabled}
{@const testTitle = !hasSessionToken ? '需重新生成 token 才能测试' : !source.enabled ? '源已停用，请先启用' : ''}
{@const testState = testStates.get(source.id)}
<button type="button"
  disabled={testDisabled || testState?.phase === 'sending'}
  title={testTitle}
  onclick={(e) => { e.stopPropagation(); ontest(source.id); }}>⚡ 测试</button>
```

After each `</tr>` for the source row (inside the `{#each}`), add the status bar row:

```svelte
{#if testState && testState.phase !== 'idle'}
  <tr class="test-status-row">
    <td colspan="5">
      <div class="test-status-bar" class:success={testState.phase === 'success'} class:error={testState.phase === 'error'} class:sending={testState.phase === 'sending'}>
        <div class="line">
          <span class="prefix">&gt;</span>
          <span class="method">POST</span>
          <span class="path">/api/webhooks/{source.topic_prefix.replace(/\.+$/, '')}</span>
        </div>
        {#if testState.phase === 'sending'}
          <div class="line">
            <span class="prefix">&lt;</span>
            <span class="status"><span class="spinner"></span> 发送中...</span>
          </div>
        {:else if testState.phase === 'success'}
          <div class="line">
            <span class="prefix">&lt;</span>
            <span class="status">{testState.status} Accepted</span>
            <span class="sep">·</span>
            <span class="event-id">{testState.eventId}</span>
            <span class="sep">·</span>
            <span class="seq">sequence {testState.sequence}</span>
          </div>
        {:else}
          <div class="line">
            <span class="prefix">&lt;</span>
            <span class="status">{testState.status ?? ''} {testState.message ?? '错误'}</span>
          </div>
        {/if}
      </div>
    </td>
  </tr>
{/if}
```

Add styles for the status bar:

```css
.test-status-row > td { padding: 0 16px 8px !important; border-bottom: 1px solid var(--border-muted) !important; }
.test-status-bar {
  padding: 8px 12px; background: var(--bg-primary); border-radius: 0 0 4px 4px;
  font-family: var(--font-mono); font-size: 11px; line-height: 1.7;
  display: flex; flex-direction: column; gap: 1px;
  border-left: 2px solid transparent;
}
.test-status-bar.success { border-left-color: var(--accent-green); }
.test-status-bar.error { border-left-color: var(--accent-red); }
.test-status-bar.sending { border-left-color: var(--accent-yellow); }
.test-status-bar .line { display: flex; align-items: center; gap: 6px; }
.test-status-bar .prefix { color: var(--text-muted); width: 8px; }
.test-status-bar .method { color: var(--accent-purple); font-weight: 600; }
.test-status-bar .path { color: var(--text-secondary); }
.test-status-bar .status { font-weight: 600; }
.test-status-bar.success .status { color: var(--accent-green); }
.test-status-bar.error .status { color: var(--accent-red); }
.test-status-bar.sending .status { color: var(--accent-yellow); display: flex; align-items: center; gap: 6px; }
.test-status-bar .sep { color: var(--text-muted); }
.test-status-bar .event-id, .test-status-bar .seq { color: var(--text-secondary); }
.spinner {
  display: inline-block; width: 8px; height: 8px;
  border: 1.5px solid var(--accent-yellow); border-top-color: transparent;
  border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 4: Run the table tests to verify GREEN**

Run: `bunx vitest run src/components/settings/WebhookSourceTable.test.ts`

Expected: PASS (12 tests).

- [ ] **Step 5: Wire test handler into WebhookPanel**

Modify `src/components/settings/WebhookPanel.svelte`. Add the test handler:

```ts
import { webhookApi, WebhookApiError } from '../../lib/webhook/api';

const testTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function handleTest(id: string): Promise<void> {
  const source = webhookStore.sources.find(s => s.id === id);
  if (!source) return;
  const token = webhookStore.sessionTokens.get(id);
  if (!token || !source.enabled) return;

  // Clear any existing timer for this source
  const existingTimer = testTimers.get(id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    testTimers.delete(id);
  }

  testStates.set(id, { phase: 'sending', at: Date.now() });
  testStates = new Map(testStates);

  const topic = source.topic_prefix.replace(/\.+$/, '');
  try {
    const result = await webhookApi.publishEvent(topic, token, { test: true, source: source.name, ts: Date.now() });
    testStates.set(id, {
      phase: 'success',
      status: 202,
      eventId: result.event_id,
      sequence: result.sequence,
      at: Date.now(),
    });
  } catch (error) {
    const status = error instanceof WebhookApiError ? error.status : 0;
    const message = error instanceof WebhookApiError ? error.message : '网络错误';
    testStates.set(id, { phase: 'error', status, message, at: Date.now() });
  }
  testStates = new Map(testStates);

  // Auto-clear after 30s
  const timer = setTimeout(() => {
    testStates.delete(id);
    testStates = new Map(testStates);
    testTimers.delete(id);
  }, 30_000);
  testTimers.set(id, timer);
}
```

Update the table prop:

```svelte
ontest={handleTest}
```

- [ ] **Step 6: Verify svelte-check and tests**

Run:

```bash
bunx vitest run src/components/settings/
bun run check
```

Expected: all tests pass; svelte-check 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/WebhookSourceTable.svelte src/components/settings/WebhookSourceTable.test.ts src/components/settings/WebhookPanel.svelte
git commit -m "feat(webhook): add inline test with status bar"
```

---

### Task 7: curl preview card

**Files:**
- Create: `src/components/settings/WebhookCurlPreview.svelte`
- Modify: `src/components/settings/WebhookPanel.svelte` (render curl card, wire copy)
- Test: `src/components/settings/WebhookCurlPreview.test.ts`

**Interfaces:**
- Produces: `WebhookCurlPreview` component with props `source: WebhookSource | null` and `token: string | null`.
- Consumes: `webhookStore.selectedSourceId`, `webhookStore.sessionTokens`.

- [ ] **Step 1: Write the failing test for curl preview**

Create `src/components/settings/WebhookCurlPreview.test.ts`:

```ts
import { render, screen, fireEvent } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import WebhookCurlPreview from './WebhookCurlPreview.svelte';
import type { WebhookSource } from '../../lib/webhook/types';

const source: WebhookSource = {
  id: 'a', name: 'siem-alert', enabled: true, provider: 'generic',
  topic_prefix: 'webhook.siem.alert.', has_token: true, has_signature_secret: false,
  body_limit_bytes: 0, created_at: '', updated_at: '',
};

test('renders placeholder when source is null', () => {
  render(WebhookCurlPreview, { props: { source: null, token: null } });
  expect(screen.getByText(/点击上方表格中的源/)).toBeInTheDocument();
});

test('renders curl command with real token when token is provided', () => {
  render(WebhookCurlPreview, { props: { source, token: 'tok_abc123' } });
  expect(screen.getByText(/tok_abc123/)).toBeInTheDocument();
  expect(screen.getByText(/webhook\.siem\.alert/)).toBeInTheDocument();
});

test('renders curl command with placeholder when token is null', () => {
  render(WebhookCurlPreview, { props: { source, token: null } });
  expect(screen.getByText(/<your-token>/)).toBeInTheDocument();
});

test('shows session-visible warning when token is present', () => {
  render(WebhookCurlPreview, { props: { source, token: 'tok_abc123' } });
  expect(screen.getByText(/包含明文 token，仅您当前会话可见/)).toBeInTheDocument();
});

test('shows regenerate hint when token is null', () => {
  render(WebhookCurlPreview, { props: { source, token: null } });
  expect(screen.getByText(/替换 <your-token> 为您的源 token/)).toBeInTheDocument();
});

test('copy button calls clipboard.writeText with curl command', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(WebhookCurlPreview, { props: { source, token: 'tok_abc123' } });
  await fireEvent.click(screen.getByRole('button', { name: '复制' }));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('tok_abc123'));
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `bunx vitest run src/components/settings/WebhookCurlPreview.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Create WebhookCurlPreview.svelte**

Create `src/components/settings/WebhookCurlPreview.svelte`:

```svelte
<script lang="ts">
  import type { WebhookSource } from '../../lib/webhook/types';

  interface Props {
    source: WebhookSource | null;
    token: string | null;
  }

  let { source, token }: Props = $props();

  function buildCurlCommand(src: WebhookSource, tok: string | null): string {
    const topic = src.topic_prefix.replace(/\.+$/, '');
    const auth = tok ?? '<your-token>';
    return [
      `curl -X POST 'http://127.0.0.1:7410/api/webhooks/${topic}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'Authorization: Bearer ${auth}' \\`,
      `  --data '{`,
      `    "alert_type": "Webshell上传",`,
      `    "src_ip": "192.168.1.50"`,
      `  }'`,
    ].join('\n');
  }

  async function copyCurl(): Promise<void> {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(buildCurlCommand(source, token));
    } catch {
      // ignore
    }
  }
</script>

<section class="section-card">
  <header class="section-card-header">
    <div>
      <span class="title">curl 示例</span>
      <span class="desc">选中源后自动生成可复制的调用命令</span>
    </div>
    <div class="spacer"></div>
    <button type="button" class="btn" onclick={copyCurl} disabled={!source}>📋 复制</button>
  </header>
  <div class="curl-card-body">
    {#if source}
      <div class="curl-source-line">
        <span class="name">{source.name}</span>
        <span>·</span>
        <span class="topic">{source.topic_prefix}</span>
      </div>
      <pre class="curl-preview">{buildCurlCommand(source, token)}</pre>
      {#if token}
        <div class="curl-warning">
          <span>⚠</span>
          <span>包含明文 token，仅您当前会话可见。关闭页面后需重新生成 token 才能再次获取。</span>
        </div>
      {:else}
        <div class="curl-warning muted">
          <span>⚠</span>
          <span>替换 &lt;your-token&gt; 为您的源 token。如需新 token，点击表格中"↻ 重生成"。</span>
        </div>
      {/if}
    {:else}
      <div class="empty-curl">点击上方表格中的源以查看 curl 示例</div>
    {/if}
  </div>
</section>

<style>
  .section-card { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden; }
  .section-card-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border-color); background: var(--bg-tertiary); }
  .section-card-header .title { font-size: var(--font-size-md); font-weight: 600; }
  .section-card-header .desc { color: var(--text-muted); font-size: var(--font-size-xs); margin-left: 8px; }
  .section-card-header .spacer { flex: 1; }
  .section-card-header .btn { padding: 5px 12px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); font-size: var(--font-size-sm); }
  .section-card-header .btn:hover:not(:disabled) { border-color: var(--accent-blue); }
  .section-card-header .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .curl-card-body { padding: 14px 16px; }
  .curl-source-line { font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  .curl-source-line .name { color: var(--text-primary); font-weight: 600; }
  .curl-source-line .topic { font-family: var(--font-mono); color: var(--accent-blue); font-size: var(--font-size-xs); }

  .curl-preview {
    background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 4px;
    padding: 12px 14px; font-family: var(--font-mono); font-size: var(--font-size-xs);
    line-height: 1.7; color: var(--text-secondary); white-space: pre-wrap; word-break: break-all;
    margin: 0;
  }

  .curl-warning {
    margin-top: 10px; padding: 6px 10px; border-radius: 3px; font-size: var(--font-size-xs);
    color: var(--accent-yellow); background: color-mix(in srgb, var(--accent-yellow) 8%, transparent);
    border-left: 2px solid var(--accent-yellow); display: flex; align-items: center; gap: 6px;
  }
  .curl-warning.muted { color: var(--text-muted); background: var(--bg-tertiary); border-left-color: var(--text-muted); }

  .empty-curl { padding: 24px; text-align: center; color: var(--text-muted); font-size: var(--font-size-sm); }
</style>
```

- [ ] **Step 4: Run the curl test to verify GREEN**

Run: `bunx vitest run src/components/settings/WebhookCurlPreview.test.ts`

Expected: PASS (6 tests).

- [ ] **Step 5: Wire curl preview into WebhookPanel**

Modify `src/components/settings/WebhookPanel.svelte`. Add import:

```ts
import WebhookCurlPreview from './WebhookCurlPreview.svelte';
```

Add a derived for the selected source and its session token:

```ts
let selectedSource = $derived(webhookStore.sources.find(s => s.id === webhookStore.selectedSourceId) ?? null);
let selectedToken = $derived(selectedSource ? webhookStore.sessionTokens.get(selectedSource.id) ?? null : null);
```

After the sources section card (and after the delete confirm modal), add:

```svelte
{#if webhookStore.sources.length > 0}
  <WebhookCurlPreview source={selectedSource} token={selectedToken} />
{/if}
```

Wire the `oncopycurl` callback to copy from the table row:

```ts
async function handleCopyCurl(id: string): Promise<void> {
  const source = webhookStore.sources.find(s => s.id === id);
  if (!source) return;
  const token = webhookStore.sessionTokens.get(id) ?? null;
  const topic = source.topic_prefix.replace(/\.+$/, '');
  const auth = token ?? '<your-token>';
  const cmd = [
    `curl -X POST 'http://127.0.0.1:7410/api/webhooks/${topic}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'Authorization: Bearer ${auth}' \\`,
    `  --data '{"alert_type":"Webshell上传","src_ip":"192.168.1.50"}'`,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(cmd);
  } catch {
    // ignore
  }
}
```

Update the table prop:

```svelte
oncopycurl={handleCopyCurl}
```

- [ ] **Step 6: Verify svelte-check and tests**

Run:

```bash
bunx vitest run src/components/settings/
bun run check
```

Expected: all tests pass; svelte-check 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/WebhookCurlPreview.svelte src/components/settings/WebhookCurlPreview.test.ts src/components/settings/WebhookPanel.svelte
git commit -m "feat(webhook): add curl preview card"
```

---

### Task 8: Token regeneration

**Files:**
- Modify: `src/components/settings/WebhookPanel.svelte` (regen handler + confirm modal)
- Test: `src/components/settings/WebhookPanel.test.ts` (create if not exists)

**Interfaces:**
- Produces: `WebhookPanel` handles `onregen` callback; shows regen confirm modal; calls `webhookStore.upsert` with new token; opens success toast showing new token.
- Consumes: `webhookStore.upsert` (with `token` field to overwrite).

- [ ] **Step 1: Write the failing test for regen flow**

Create `src/components/settings/WebhookPanel.test.ts`:

```ts
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WebhookPanel from './WebhookPanel.svelte';

const storeMock = vi.hoisted(() => ({
  sources: [] as Array<{ id: string; name: string; enabled: boolean; provider: string; topic_prefix: string; has_token: boolean; has_signature_secret: boolean; body_limit_bytes: number; created_at: string; updated_at: string }>,
  loading: false,
  lastError: null,
  selectedSourceId: null as string | null,
  sessionTokens: new Map<string, string>(),
  loadSources: vi.fn(),
  selectSource: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../lib/webhook/store.svelte', () => ({ webhookStore: storeMock }));
vi.mock('../../lib/webhook/api', () => ({ webhookApi: { publishEvent: vi.fn() }, WebhookApiError: class extends Error {} }));

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.sources = [{
    id: 'a', name: 'siem-alert', enabled: true, provider: 'generic',
    topic_prefix: 'webhook.siem.alert.', has_token: true, has_signature_secret: false,
    body_limit_bytes: 0, created_at: '', updated_at: '',
  }];
  storeMock.selectedSourceId = 'a';
  storeMock.sessionTokens = new Map([['a', 'old-token']]);
});

afterEach(() => vi.restoreAllMocks());

test('clicking regen button opens confirm modal', async () => {
  render(WebhookPanel);
  await fireEvent.click(screen.getByRole('button', { name: /↻ 重生成/ }));
  expect(screen.getByText('重新生成 Token')).toBeInTheDocument();
  expect(screen.getByText(/重新生成 siem-alert 的 token/)).toBeInTheDocument();
});

test('confirming regen calls upsert with new token and shows new token display', async () => {
  storeMock.upsert.mockResolvedValueOnce(storeMock.sources[0]);
  render(WebhookPanel);
  await fireEvent.click(screen.getByRole('button', { name: /↻ 重生成/ }));
  await fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
  await waitFor(() => {
    expect(storeMock.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a',
      token: expect.stringMatching(/^tok_[a-f0-9]{24}$/),
    }));
  });
  await waitFor(() => {
    expect(screen.getByText(/新 token 已生成/)).toBeInTheDocument();
  });
});

test('canceling regen closes modal without calling upsert', async () => {
  render(WebhookPanel);
  await fireEvent.click(screen.getByRole('button', { name: /↻ 重生成/ }));
  await fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(storeMock.upsert).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `bunx vitest run src/components/settings/WebhookPanel.test.ts`

Expected: FAIL — regen button not wired or confirm modal missing.

- [ ] **Step 3: Add regen state and modal to WebhookPanel**

Modify `src/components/settings/WebhookPanel.svelte`. Add regen state alongside the delete state:

```ts
let regenTarget = $state<{ id: string; name: string } | null>(null);
let regenPending = $state(false);
let regenNewToken = $state<string | null>(null);

function handleRegenRequest(id: string): void {
  const source = webhookStore.sources.find(s => s.id === id);
  if (!source) return;
  regenTarget = { id, name: source.name };
  regenNewToken = null;
}

function handleRegenCancel(): void {
  regenTarget = null;
  regenNewToken = null;
}

async function handleRegenConfirm(): Promise<void> {
  if (!regenTarget) return;
  const source = webhookStore.sources.find(s => s.id === regenTarget.id);
  if (!source) return;
  const newToken = 'tok_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  regenPending = true;
  try {
    await webhookStore.upsert({
      id: source.id,
      name: source.name,
      enabled: source.enabled,
      provider: source.provider,
      topic_prefix: source.topic_prefix,
      token: newToken,
      signature_type: source.signature_type ?? 'none',
    });
    regenNewToken = newToken;
  } catch (error) {
    console.error('regen failed', error);
  } finally {
    regenPending = false;
  }
}

function handleRegenDone(): void {
  regenTarget = null;
  regenNewToken = null;
}

async function copyRegenToken(): Promise<void> {
  if (!regenNewToken) return;
  try {
    await navigator.clipboard.writeText(regenNewToken);
  } catch {
    // ignore
  }
}
```

Update the table prop:

```svelte
onregen={handleRegenRequest}
```

Add the regen confirm + success modal (alongside the delete modal):

```svelte
{#if regenTarget && !regenNewToken}
  <div class="modal-backdrop" onclick={(e) => { if (e.target === e.currentTarget && !regenPending) handleRegenCancel(); }}>
    <div class="modal" role="dialog" aria-modal="true">
      <header class="modal-header">
        <span class="icon warn">↻</span>
        <div class="title">重新生成 Token</div>
        <button type="button" class="close" onclick={handleRegenCancel} disabled={regenPending}>×</button>
      </header>
      <div class="modal-body">
        <p>重新生成 <code>{regenTarget.name}</code> 的 token 会使旧 token 立即失效。</p>
        <ul class="impact-list">
          <li>所有使用旧 token 的调用方将收到 401，需要更新配置</li>
          <li>新 token 仅在本次会话显示，关闭后不再可见</li>
          <li>历史事件不受影响，仍可通过原 event_id 查询</li>
        </ul>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn" onclick={handleRegenCancel} disabled={regenPending}>取消</button>
        <button type="button" class="btn primary" onclick={handleRegenConfirm} disabled={regenPending}>
          {#if regenPending}重新生成中...{:else}重新生成{/if}
        </button>
      </footer>
    </div>
  </div>
{:else if regenTarget && regenNewToken}
  <div class="modal-backdrop">
    <div class="modal" role="dialog" aria-modal="true">
      <header class="modal-header">
        <span class="icon success">✓</span>
        <div class="title">新 token 已生成</div>
      </header>
      <div class="modal-body">
        <div class="alert-banner warn">
          <span class="icon">⚠</span>
          <span>这是您最后一次能看到此 token。旧 token 已立即失效。</span>
        </div>
        <div class="field">
          <label>访问 Token</label>
          <div class="token-display">
            <span class="value">{regenNewToken}</span>
            <button type="button" onclick={copyRegenToken}>📋 复制</button>
          </div>
        </div>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn primary" onclick={handleRegenDone}>我已保存，关闭</button>
      </footer>
    </div>
  </div>
{/if}
```

Add necessary styles for `.icon.warn` (color: var(--accent-yellow)), `.impact-list`, `.alert-banner`, `.token-display` if not already present from Task 5.

- [ ] **Step 4: Run all webhook tests to verify GREEN**

Run:

```bash
bunx vitest run src/components/settings/ src/lib/webhook/
bun run check
```

Expected: all tests pass; svelte-check 0 errors.

- [ ] **Step 5: Manual verification in browser**

Run: `bun run dev`

In the browser, navigate to system settings → Webhooks tab. Verify:

1. Existing sources from backend load into the table
2. Click "+ 注册源", fill name + topic_prefix (e.g., `webhook.test.signal.`), click "注册"
3. Success view shows the token; click "我已保存，关闭"
4. New source appears in table with "会话内" badge
5. Click "⚡ 测试" — status bar shows `> POST /api/webhooks/webhook.test.signal` and `< 202 Accepted · evt_xxx · sequence N`
6. Click "↻ 重生成" on the same row — confirm modal appears
7. Confirm — new token modal appears with new token
8. Click "📋 curl" — curl command copied to clipboard
9. Click "✕" on the row — delete confirm appears
10. Confirm — source disappears from table

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/WebhookPanel.svelte src/components/settings/WebhookPanel.test.ts
git commit -m "feat(webhook): add token regeneration"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §2 v1 scope (table, register, test, delete, regen, curl) | Tasks 3–8 |
| §3 backend contract | Task 1 (API client) |
| §4 component architecture | Tasks 1–8 |
| §5.1 initial load | Task 3 |
| §5.2 register | Task 4 |
| §5.3 toggle | Task 5 |
| §5.4 test | Task 6 |
| §5.5 delete | Task 5 |
| §5.6 regen | Task 8 |
| §5.7 curl | Task 7 |
| §6.1 table columns | Task 3 |
| §6.2 test status bar (signature element) | Task 6 |
| §6.3 session badge | Task 3 |
| §6.4 register modal three views | Task 4 |
| §6.5 curl preview three token states | Task 7 |
| §7 error handling | Tasks 1 (api), 5 (delete), 6 (test) |
| §8 implementation plan milestones | Tasks 1–8 (1:1 mapping) |
| §10 acceptance checklist | Manual verification in Task 8 Step 5 |

No gaps.

**2. Placeholder scan:**

Searched for "TBD", "TODO", "fill in", "similar to", "add appropriate". None found. Each step has actual test code or implementation code.

**3. Type consistency:**

- `WebhookSource` shape used in Tasks 1, 3, 4, 7, 8 matches (id, name, enabled, provider, topic_prefix, has_token, has_signature_secret, body_limit_bytes, created_at, updated_at).
- `WebhookSourceRequest` in Task 1 matches what Tasks 4/5/8 pass to `webhookStore.upsert` (id, name, enabled, provider, topic_prefix, token, signature_type).
- `webhookApi.publishEvent(topic, token, body)` signature defined in Task 1, called in Task 6 with `(topic, token, { test: true, source: source.name, ts: Date.now() })` — matches.
- `webhookStore` methods used: `loadSources`, `selectSource`, `upsert`, `remove`, `sessionTokens`, `sources`, `loading`, `lastError`, `selectedSourceId` — all defined in Task 1.
- `TestState` type used in Tasks 1, 3, 6 matches: `phase: 'sending' | 'success' | 'error'`, `status?`, `eventId?`, `sequence?`, `message?`, `at`.
- `WebhookSourceTable` Props added across tasks: Task 3 has 4 props (sources, sessionTokenIds, selectedSourceId, testStates); Task 5 adds 6 callbacks (onselect, ontoggle, ondelete, oncopycurl, ontest, onregen). All Props used consistently in Tasks 5, 6, 7, 8 panel wiring.

No type drift detected.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-22-webhook-source-management.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
