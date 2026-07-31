import {
  ImageAvailabilityStatus,
  ImageStoreKind,
  type ImagePlatform,
} from '../gen/agentcompose/v2/agentcompose_pb';

export function formatImageBytes(value: bigint | number | string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** index;
  return `${amount >= 10 || Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

export function formatImagePlatform(platform?: Pick<ImagePlatform, 'os' | 'architecture' | 'variant'>): string {
  if (!platform) return '后端未提供';
  const value = [platform.os, platform.architecture, platform.variant].filter(Boolean).join('/');
  return value || '后端未提供';
}

export function imageStoreLabel(store: ImageStoreKind): string {
  if (store === ImageStoreKind.DOCKER_DAEMON) return 'Docker daemon';
  if (store === ImageStoreKind.OCI_CACHE) return 'OCI 缓存';
  return '未指定';
}

export function imageAvailabilityLabel(status: ImageAvailabilityStatus): string {
  if (status === ImageAvailabilityStatus.AVAILABLE) return '可用';
  if (status === ImageAvailabilityStatus.MISSING) return '缺失';
  if (status === ImageAvailabilityStatus.ERROR) return '错误';
  return '未知';
}
