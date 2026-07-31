import type { RunSummary } from '../gen/agentcompose/v2/agentcompose_pb';

function localDate(value: string, nextDay = false): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + (nextDay ? 1 : 0), 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function buildRunDateRange(from: string, to: string): { startedFrom: string; startedTo: string } {
  const lower = localDate(from);
  const nextUpper = localDate(to, true);
  return {
    startedFrom: lower?.toISOString() ?? '',
    startedTo: nextUpper ? new Date(nextUpper.getTime() - 1).toISOString() : '',
  };
}

export function consumeRunWindow(serverRuns: RunSummary[], target: number): { runs: RunSummary[]; serverOffset: number; hasMore: boolean } {
  const consumed = serverRuns.slice(0, target);
  const positions = new Map<string, number>();
  const runs: RunSummary[] = [];
  for (const run of consumed) {
    const position = positions.get(run.runId);
    if (position === undefined) { positions.set(run.runId, runs.length); runs.push(run); }
    else runs[position] = run;
  }
  return { runs, serverOffset: consumed.length, hasMore: serverRuns.length > target };
}
