import { healthClient } from './client';

export type HealthStatus = {
  version: string;
  currentTime: string;
  startedAt: string;
  uptimeSeconds: number;
  goVersion: string;
  numGoroutines: number;
  memorySys: number;
  memoryHeapAlloc: number;
  processCpuPercent: number;
  processCpuUserMillis: number;
  processCpuSystemMillis: number;
  processRssBytes: number;
  processReadBytes: number;
  processWriteBytes: number;
  processReadOps: number;
  processWriteOps: number;
};

export async function getHealthStatus(): Promise<HealthStatus> {
  const response = await healthClient.status({});
  return healthStatusFromResponse(response);
}

export async function watchHealthStatus(onStatus: (status: HealthStatus) => void, signal?: AbortSignal): Promise<void> {
  for await (const response of healthClient.watchStatus({}, { signal })) {
    onStatus(healthStatusFromResponse(response));
  }
}

function healthStatusFromResponse(response: Awaited<ReturnType<typeof healthClient.status>>): HealthStatus {
  return {
    version: response.version,
    currentTime: response.currentTime,
    startedAt: response.startedAt,
    uptimeSeconds: Number(response.uptimeSeconds),
    goVersion: response.goVersion,
    numGoroutines: Number(response.numGoroutines),
    memorySys: Number(response.memory?.sys ?? 0),
    memoryHeapAlloc: Number(response.memory?.heapAlloc ?? 0),
    processCpuPercent: response.process?.cpuPercent ?? 0,
    processCpuUserMillis: Number(response.process?.cpuUserMillis ?? 0),
    processCpuSystemMillis: Number(response.process?.cpuSystemMillis ?? 0),
    processRssBytes: Number(response.process?.rssBytes ?? 0),
    processReadBytes: Number(response.process?.readBytes ?? 0),
    processWriteBytes: Number(response.process?.writeBytes ?? 0),
    processReadOps: Number(response.process?.readOps ?? 0),
    processWriteOps: Number(response.process?.writeOps ?? 0),
  };
}
