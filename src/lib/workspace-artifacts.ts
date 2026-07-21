import { Code, ConnectError } from '@connectrpc/connect';
import {
  ExecCommand,
  ExecRequest,
  ExecStreamEventType,
  GetSandboxRequest,
  StdioStream,
  type ExecStreamResponse,
} from '../gen/agentcompose/v2/agentcompose_pb';

export const WORKSPACE_ARTIFACT_OUTPUT_BYTES = 256 * 1024;
export const MAX_WORKSPACE_ARTIFACT_FILES = 5000;

export interface WorkspaceArtifactFile {
  path: string;
  modifiedAt: string;
  modifiedAtMs: number;
}

export interface ParseWorkspaceArtifactOptions {
  startedAt: string;
  endedAt: string;
  limit: number;
  truncated?: boolean;
}

export function parseWorkspaceArtifactRecords(
  raw: string,
  options: ParseWorkspaceArtifactOptions,
): { files: WorkspaceArtifactFile[]; truncated: boolean } {
  const start = Date.parse(options.startedAt);
  const end = Date.parse(options.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return { files: [], truncated: false };

  const records = raw.split('\n');
  if (records.at(-1) === '') records.pop();

  const byPath = new Map<string, WorkspaceArtifactFile>();
  for (const record of records) {
    const separator = record.indexOf('\t');
    if (separator < 1) continue;
    const modifiedAtMs = Number.parseFloat(record.slice(0, separator)) * 1000;
    const path = record.slice(separator + 1);
    if (!Number.isFinite(modifiedAtMs) || !path.startsWith('/workspace/') || modifiedAtMs < start || modifiedAtMs > end) continue;
    byPath.set(path, { path, modifiedAtMs, modifiedAt: new Date(modifiedAtMs).toISOString() });
  }

  const files = [...byPath.values()]
    .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs || left.path.localeCompare(right.path))
    .slice(0, options.limit);
  return { files, truncated: Boolean(options.truncated) || byPath.size > options.limit };
}

export type WorkspaceArtifactDiscoveryStatus = 'ready' | 'stopped' | 'removed' | 'invalid-time' | 'error';

export interface WorkspaceArtifactDiscoveryResult {
  status: WorkspaceArtifactDiscoveryStatus;
  files: WorkspaceArtifactFile[];
  truncated: boolean;
  message: string;
}

export interface DiscoverWorkspaceArtifactsOptions {
  sandboxId: string;
  startedAt: string;
  completedAt: string;
  now: () => Date;
  getSandbox(request: GetSandboxRequest, options?: { signal?: AbortSignal }): Promise<{ sandbox?: { status?: string } }>;
  execStream(request: ExecRequest, options?: { signal?: AbortSignal }): AsyncIterable<ExecStreamResponse>;
  signal?: AbortSignal;
}

function emptyResult(status: WorkspaceArtifactDiscoveryStatus, message: string): WorkspaceArtifactDiscoveryResult {
  return { status, files: [], truncated: false, message };
}

export async function discoverWorkspaceArtifacts(
  options: DiscoverWorkspaceArtifactsOptions,
): Promise<WorkspaceArtifactDiscoveryResult> {
  const currentTime = options.completedAt ? undefined : options.now();
  const start = Date.parse(options.startedAt);
  const end = options.completedAt ? Date.parse(options.completedAt) : currentTime!.getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return emptyResult('invalid-time', 'Run time window is invalid.');
  }
  const endedAt = options.completedAt || currentTime!.toISOString();

  let status: string;
  try {
    const response = await options.getSandbox(new GetSandboxRequest({ sandboxId: options.sandboxId }), { signal: options.signal });
    status = response.sandbox?.status?.trim().toUpperCase() ?? '';
  } catch (error) {
    if (ConnectError.from(error).code === Code.NotFound) return emptyResult('removed', 'Sandbox has been removed.');
    return emptyResult('error', ConnectError.from(error).message || 'Unable to inspect Sandbox.');
  }

  if (status === 'STOPPED') return emptyResult('stopped', 'Sandbox is stopped.');
  if (status === 'REMOVED' || status === 'DESTROYED') return emptyResult('removed', 'Sandbox has been removed.');
  if (status !== 'RUNNING') return emptyResult('error', 'Sandbox is not available for artifact discovery.');

  const request = new ExecRequest({
    target: { case: 'sandboxId', value: options.sandboxId },
    command: new ExecCommand({ command: '/usr/bin/find', args: ['/workspace', '-type', 'f', '-printf', '%T@\\t%p\\n'] }),
    cwd: '/workspace',
    maxOutputBytes: WORKSPACE_ARTIFACT_OUTPUT_BYTES,
    timeoutMs: 30_000,
  });
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let outputBytes = 0;
  let truncated = false;

  try {
    for await (const event of options.execStream(request, { signal: options.signal })) {
      if (event.eventType === ExecStreamEventType.OUTPUT && event.stream === StdioStream.STDERR) {
        return emptyResult('error', event.chunk || 'Artifact discovery wrote to stderr.');
      }
      if (event.result?.error) return emptyResult('error', event.result.error);
      if (event.result?.stdoutTruncated || event.result?.outputTruncated) truncated = true;
      if (event.eventType !== ExecStreamEventType.OUTPUT || event.stream !== StdioStream.STDOUT || !event.chunk) continue;

      const bytes = encoder.encode(event.chunk);
      const remaining = WORKSPACE_ARTIFACT_OUTPUT_BYTES - outputBytes;
      if (bytes.byteLength > remaining) truncated = true;
      if (remaining > 0) {
        const accepted = bytes.byteLength > remaining ? bytes.slice(0, remaining) : bytes;
        chunks.push(accepted);
        outputBytes += accepted.byteLength;
      }
    }
  } catch (error) {
    return emptyResult('error', ConnectError.from(error).message || 'Artifact discovery failed.');
  }

  const bytes = new Uint8Array(outputBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = parseWorkspaceArtifactRecords(new TextDecoder().decode(bytes), {
    startedAt: options.startedAt,
    endedAt,
    limit: MAX_WORKSPACE_ARTIFACT_FILES,
    truncated,
  });
  return { status: 'ready', files: parsed.files, truncated: parsed.truncated, message: '' };
}
