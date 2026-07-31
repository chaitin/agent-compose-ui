import { Code, ConnectError } from '@connectrpc/connect';
import type { RunSummary } from '../gen/agentcompose/v2/agentcompose_pb';

export interface SandboxInventory {
  sandboxId: string;
  latestRunId: string;
  agentName: string;
  firstSeenAt: string;
  updatedAt: string;
  runCount: number;
  runs: InventoryRun[];
}

export type InventoryRun = Pick<RunSummary, 'runId' | 'sandboxId' | 'agentName' | 'updatedAt' | 'createdAt'>
  & Partial<Pick<RunSummary, 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'warnings'>>;

export type SandboxLifecycle = 'detecting' | 'running' | 'stopped' | 'destroyed' | 'unknown';

export interface SandboxProbeResult {
  lifecycle: SandboxLifecycle;
  statsUnavailable: boolean;
  message?: string;
}

function errorEvidence(error: unknown): { code: Code; message: string } {
  if (error && typeof error === 'object' && 'code' in error) {
    const candidate = error as { code?: Code; rawMessage?: string; message?: string };
    return { code: candidate.code ?? Code.Unknown, message: candidate.rawMessage || candidate.message || '' };
  }
  const connected = ConnectError.from(error);
  return { code: connected.code, message: connected.rawMessage || connected.message };
}

export function classifySandboxProbe(error?: unknown): SandboxProbeResult {
  if (error == null) return { lifecycle: 'running', statsUnavailable: false };
  const evidence = errorEvidence(error);
  if (evidence.code === Code.NotFound) {
    return { lifecycle: 'destroyed', statsUnavailable: false, message: evidence.message };
  }
  if (evidence.code === Code.FailedPrecondition && /\bnot running\b/i.test(evidence.message)) {
    return { lifecycle: 'stopped', statsUnavailable: false, message: evidence.message };
  }
  if (evidence.code === Code.Unimplemented) {
    return { lifecycle: 'running', statsUnavailable: true, message: evidence.message };
  }
  return { lifecycle: 'unknown', statsUnavailable: false, message: evidence.message };
}

export function groupSandboxInventory(runs: readonly InventoryRun[]): SandboxInventory[] {
  const grouped = new Map<string, InventoryRun[]>();
  const sorted = [...runs]
    .filter(run => run.sandboxId)
    .sort((left, right) => (right.updatedAt || right.createdAt).localeCompare(left.updatedAt || left.createdAt));

  for (const run of sorted) {
    const sandboxRuns = grouped.get(run.sandboxId) ?? [];
    sandboxRuns.push(run);
    grouped.set(run.sandboxId, sandboxRuns);
  }

  return [...grouped.entries()].map(([sandboxId, sandboxRuns]) => {
    const newest = sandboxRuns[0];
    const oldest = sandboxRuns[sandboxRuns.length - 1];
    return {
      sandboxId,
      latestRunId: newest.runId,
      agentName: newest.agentName,
      firstSeenAt: oldest.createdAt || oldest.updatedAt,
      updatedAt: newest.updatedAt || newest.createdAt,
      runCount: sandboxRuns.length,
      runs: sandboxRuns,
    };
  });
}

const lifecycleOrder: Record<SandboxLifecycle, number> = {
  running: 0, stopped: 1, unknown: 2, detecting: 2, destroyed: 3,
};

export function sortSandboxInventory(
  items: readonly SandboxInventory[],
  lifecycle: Readonly<Record<string, SandboxLifecycle | undefined>>,
): SandboxInventory[] {
  return [...items].sort((left, right) => {
    const stateDifference = lifecycleOrder[lifecycle[left.sandboxId] ?? 'detecting']
      - lifecycleOrder[lifecycle[right.sandboxId] ?? 'detecting'];
    return stateDifference || right.updatedAt.localeCompare(left.updatedAt);
  });
}
