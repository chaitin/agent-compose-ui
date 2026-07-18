import {
  ListSandboxesRequest,
  type ListSandboxesResponse,
  type Sandbox,
} from '../gen/agentcompose/v2/agentcompose_pb';

export type SandboxPageFetcher = (
  request: ListSandboxesRequest,
  options?: { signal?: AbortSignal },
) => Promise<ListSandboxesResponse>;

export async function listAllSandboxes(fetchPage: SandboxPageFetcher, signal?: AbortSignal): Promise<Sandbox[]> {
  const records: Sandbox[] = [];
  const seen = new Set<string>();
  let cursor = '';

  while (true) {
    const response = await fetchPage(new ListSandboxesRequest({ limit: 100, cursor }), { signal });
    records.push(...response.sandboxes);
    if (!response.nextCursor) return records;
    if (seen.has(response.nextCursor)) throw new Error(`Sandbox pagination returned repeated cursor: ${response.nextCursor}`);
    seen.add(response.nextCursor);
    cursor = response.nextCursor;
  }
}

function tagValue(record: Sandbox, name: string): string {
  return record.tags.find(tag => tag.name === name)?.value ?? '';
}

export function filterSandboxes(
  records: readonly Sandbox[],
  target: { projectId: string; agentName?: string },
): Sandbox[] {
  return records.filter(record => {
    const projectId = record.projectId || tagValue(record, 'project');
    const agentName = record.agentName || tagValue(record, 'agent');
    return projectId === target.projectId && (!target.agentName || agentName === target.agentName);
  });
}

export function sandboxLifecycle(status: string): 'running' | 'stopped' | 'destroyed' | 'unknown' {
  switch (status.trim().toLowerCase()) {
    case 'running': return 'running';
    case 'stopped':
    case 'exited': return 'stopped';
    case 'destroyed':
    case 'removed':
    case 'deleted': return 'destroyed';
    default: return 'unknown';
  }
}
