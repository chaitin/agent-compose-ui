import { apiPath } from '../paths';
import { apiFetchJson } from './http';

export type AuditPrincipal = { id: string; source: string; username: string; displayName: string; authMethod: string };
export type AuditEvent = {
  id: string;
  occurredAt: string;
  finishedAt?: string;
  actor: AuditPrincipal;
  category: string;
  action: string;
  resourceType: string;
  resourceId: string;
  method: string;
  path: string;
  outcome: string;
  status: number;
  durationMs: number;
  requestId: string;
  remoteIp: string;
  userAgent: string;
};
export type AuditFilter = {
  from?: string;
  to?: string;
  actor?: string;
  action?: string;
  outcome?: string;
  resourceType?: string;
  resourceId?: string;
  cursor?: string;
  limit?: number;
};
export type AuditPage = { items: AuditEvent[]; nextCursor: string; hasMore: boolean };
type RawAuditPrincipal = Partial<AuditPrincipal>;
type RawAuditEvent = Partial<Omit<AuditEvent, 'actor'>> & { actor?: RawAuditPrincipal };
type RawAuditPage = { items?: RawAuditEvent[]; nextCursor?: string; hasMore?: boolean };

function queryString(filter: AuditFilter, includeCursor = true): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if ((!includeCursor && key === 'cursor') || value === undefined || value === '') continue;
    query.set(key, String(value));
  }
  return query.toString();
}

export async function listAuditEvents(filter: AuditFilter): Promise<AuditPage> {
  const page = await apiFetchJson<RawAuditPage>(`/api/ui/v1/audit/events?${queryString(filter)}`);
  return {
    items: (page.items ?? []).map(normalizeAuditEvent),
    nextCursor: page.nextCursor ?? '',
    hasMore: Boolean(page.hasMore),
  };
}

function normalizeAuditEvent(item: RawAuditEvent): AuditEvent {
  return {
    id: item.id ?? '',
    occurredAt: item.occurredAt ?? '',
    finishedAt: item.finishedAt,
    actor: {
      id: item.actor?.id ?? '',
      source: item.actor?.source ?? '',
      username: item.actor?.username ?? '',
      displayName: item.actor?.displayName ?? '',
      authMethod: item.actor?.authMethod ?? '',
    },
    category: item.category ?? '',
    action: item.action ?? '',
    resourceType: item.resourceType ?? '',
    resourceId: item.resourceId ?? '',
    method: item.method ?? '',
    path: item.path ?? '',
    outcome: item.outcome ?? '',
    status: item.status ?? 0,
    durationMs: item.durationMs ?? 0,
    requestId: item.requestId ?? '',
    remoteIp: item.remoteIp ?? '',
    userAgent: item.userAgent ?? '',
  };
}

export function downloadAuditEvents(format: 'json' | 'csv', filter: AuditFilter): void {
  const anchor = document.createElement('a');
  anchor.href = apiPath(`/api/ui/v1/audit/export?format=${format}&${queryString(filter, false)}`);
  anchor.download = `audit-events.${format}`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
