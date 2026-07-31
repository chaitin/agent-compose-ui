import type { MetricValue } from '../gen/agentcompose/v2/agentcompose_pb';

export function formatMetric(metric?: Pick<MetricValue, 'value' | 'unit'>): string {
  if (metric?.value == null) return '不可用';
  if (/^(?:percent|%)$/i.test(metric.unit)) return `${metric.value.toFixed(1)}%`;
  if (/^(?:seconds?|s)$/i.test(metric.unit)) {
    if (Math.abs(metric.value) < 60) return `${metric.value.toFixed(1)}s`;
    let remaining = Math.max(0, Math.round(metric.value));
    const days = Math.floor(remaining / 86400);
    remaining %= 86400;
    const hours = Math.floor(remaining / 3600);
    remaining %= 3600;
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    const parts = [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`, !days && seconds && `${seconds}s`].filter(Boolean);
    return parts.join(' ');
  }
  if (/^(?:bytes?|b)$/i.test(metric.unit)) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = metric.value;
    let index = 0;
    while (Math.abs(value) >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(1)} ${units[index]}`;
  }
  return `${metric.value.toFixed(1)}${metric.unit}`;
}

export function sandboxJupyterPath(sandboxId: string, basePath = '/jupyter'): string {
  return `${basePath.replace(/\/+$/, '')}/${encodeURIComponent(sandboxId.trim())}`;
}
