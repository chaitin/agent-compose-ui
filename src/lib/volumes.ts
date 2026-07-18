import type { Volume } from '../gen/agentcompose/v2/agentcompose_pb';

export function volumeName(volume: Volume): string { return volume.name || '后端未提供'; }
export function formatVolumeTime(value: string): string {
  if (!value) return '后端未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}
