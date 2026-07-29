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

function queryString(filter: AuditFilter, includeCursor = true): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if ((!includeCursor && key === 'cursor') || value === undefined || value === '') continue;
    query.set(key, String(value));
  }
  return query.toString();
}

export function listAuditEvents(filter: AuditFilter): Promise<AuditPage> {
  return apiFetchJson<AuditPage>(`/api/ui/v1/audit/events?${queryString(filter)}`);
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
