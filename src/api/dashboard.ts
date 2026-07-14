import { dashboardClient } from './client';

export type DashboardOverview = {
  runningCount: number;
  recentCount: number;
  attentionCount: number;
  updatedAt: string;
};

export async function getDashboardOverview(signal?: AbortSignal): Promise<DashboardOverview> {
  const resp = await dashboardClient.getDashboardOverview({}, { signal });
  return toDashboardOverview(resp.overview);
}

export async function watchDashboardOverview(
  onOverview: (overview: DashboardOverview, reason: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const stream = dashboardClient.watchDashboardOverview({}, { signal });
  for await (const event of stream) {
    onOverview(toDashboardOverview(event.overview), event.reason);
  }
}

function toDashboardOverview(overview?: {
  runs?: { runningCount?: number; recentCount?: number; attentionCount?: number };
  updatedAt?: { seconds?: bigint; nanos?: number };
}): DashboardOverview {
  return {
    runningCount: Number(overview?.runs?.runningCount ?? 0),
    recentCount: Number(overview?.runs?.recentCount ?? 0),
    attentionCount: Number(overview?.runs?.attentionCount ?? 0),
    updatedAt: overview?.updatedAt ? new Date(Number(overview.updatedAt.seconds ?? 0n) * 1000 + Number(overview.updatedAt.nanos ?? 0) / 1e6).toISOString() : '',
  };
}
