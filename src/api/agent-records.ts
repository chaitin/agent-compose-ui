import { apiPath } from '../paths';
import { apiFetchJson } from './http';

export type AgentRecord = {
  id: string;
  provider: 'codex' | 'claude' | string;
  path: string;
  size: number;
  modifiedAt: string;
};

export type AgentRecordChunk = {
  record: AgentRecord;
  content: string;
  startOffset: number;
  endOffset: number;
  totalBytes: number;
  hasEarlier: boolean;
};

export async function listAgentRecords(sandboxId: string): Promise<AgentRecord[]> {
  const response = await apiFetchJson<{ items?: AgentRecord[] }>(
    `/api/ui/v1/sandboxes/${encodeURIComponent(sandboxId)}/agent-records`,
  );
  return response.items ?? [];
}

export function readAgentRecord(sandboxId: string, recordId: string, before?: number): Promise<AgentRecordChunk> {
  const query = new URLSearchParams({ limit: String(256 << 10) });
  if (before !== undefined) query.set('before', String(before));
  return apiFetchJson<AgentRecordChunk>(
    `/api/ui/v1/sandboxes/${encodeURIComponent(sandboxId)}/agent-records/${encodeURIComponent(recordId)}?${query}`,
  );
}

export function downloadAgentRecord(sandboxId: string, record: AgentRecord): void {
  const anchor = document.createElement('a');
  anchor.href = apiPath(
    `/api/ui/v1/sandboxes/${encodeURIComponent(sandboxId)}/agent-records/${encodeURIComponent(record.id)}?download=1`,
  );
  anchor.download = record.path.split('/').pop() || 'agent-record.jsonl';
  anchor.click();
}
