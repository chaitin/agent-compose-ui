export interface EventSandboxLink {
  sandboxId: string;
  relation: string;
  loaderId: string;
  runId: string;
  triggerId: string;
  loaderEventId: string;
  eventId: string;
  createdAt: string;
}

interface EventSandboxLinkWire {
  sandbox_id?: string;
  session_id?: string;
  relation?: string;
  loader_id?: string;
  run_id?: string;
  trigger_id?: string;
  loader_event_id?: string;
  event_id?: string;
  created_at?: string;
}

interface EventSandboxLinksWireResponse {
  sandboxes?: EventSandboxLinkWire[] | null;
  sessions?: EventSandboxLinkWire[] | null;
}

function createdAtValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLink(item: EventSandboxLinkWire): EventSandboxLink | null {
  const sandboxId = (item.session_id || item.sandbox_id || '').trim();
  if (!sandboxId) return null;
  return {
    sandboxId,
    relation: item.relation || '',
    loaderId: item.loader_id || '',
    runId: item.run_id || '',
    triggerId: item.trigger_id || '',
    loaderEventId: item.loader_event_id || '',
    eventId: item.event_id || '',
    createdAt: item.created_at || '',
  };
}

export async function loadEventSandboxLinks(
  eventId: string,
  fetcher: typeof fetch = fetch,
): Promise<EventSandboxLink[]> {
  const response = await fetcher(`/api/events/${encodeURIComponent(eventId)}/sessions`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`加载 Event Session 失败（${response.status}）`);
  const body = await response.json() as EventSandboxLinksWireResponse;
  const items = Array.isArray(body.sessions) ? body.sessions : Array.isArray(body.sandboxes) ? body.sandboxes : [];
  const links = new Map<string, EventSandboxLink>();
  for (const item of items) {
    const link = normalizeLink(item);
    if (!link) continue;
    const existing = links.get(link.sandboxId);
    if (!existing || createdAtValue(link.createdAt) >= createdAtValue(existing.createdAt)) links.set(link.sandboxId, link);
  }
  return [...links.values()];
}
