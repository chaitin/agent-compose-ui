import {
  ListSandboxesRequest,
  SandboxStatus,
  type ListSandboxesResponse,
  type Sandbox,
} from '../gen/agentcompose/v2/agentcompose_pb';

export type SandboxPageFetcher = (
  request: ListSandboxesRequest,
  options?: { signal?: AbortSignal },
) => Promise<ListSandboxesResponse>;

export async function listAllSandboxes(fetchPage: SandboxPageFetcher, signal?: AbortSignal): Promise<Sandbox[]> {
  const records: Sandbox[] = [];
  let offset = 0;

  while (true) {
    const response = await fetchPage(new ListSandboxesRequest({ limit: 100, offset }), { signal });
    records.push(...response.sandboxes);
    if (response.sandboxes.length === 0 || records.length >= response.total) return records;
    offset += response.sandboxes.length;
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

export function sandboxLifecycle(status?: SandboxStatus): 'running' | 'stopped' | 'destroyed' | 'unknown' {
  switch (status) {
    case SandboxStatus.RUNNING:
      return 'running';
    case SandboxStatus.STOPPED:
    case SandboxStatus.FAILED:
      return 'stopped';
    case SandboxStatus.DELETING:
      return 'destroyed';
    default:
      return 'unknown';
  }
}
