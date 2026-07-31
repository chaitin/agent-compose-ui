import { CacheDomain, CacheStatus, type CacheItem } from '../gen/agentcompose/v2/agentcompose_pb';

export function cacheDomainLabel(value: CacheDomain): string {
  return ({
    [CacheDomain.OCI_IMAGE_STORE]: 'OCI 镜像存储',
    [CacheDomain.MATERIALIZED_IMAGE_CACHE]: '物化镜像缓存',
    [CacheDomain.RUNTIME_DERIVED_CACHE]: '运行时派生缓存',
    [CacheDomain.SANDBOX_EPHEMERAL_STATE]: '沙箱临时状态',
  } as Record<number, string>)[value] ?? '未指定';
}

export function cacheStatusLabel(value: CacheStatus): string {
  return ({
    [CacheStatus.ACTIVE]: '活跃', [CacheStatus.REFERENCED]: '被引用', [CacheStatus.UNUSED]: '未使用',
    [CacheStatus.EXPIRED]: '已过期', [CacheStatus.ORPHANED]: '孤立',
  } as Record<number, string>)[value] ?? '未知';
}

export function cacheId(item: CacheItem): string { return item.cacheId || '后端未提供'; }
export function formatBytes(value: bigint): string {
  const size = Number(value);
  if (!Number.isFinite(size)) return String(value);
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MiB`;
  return `${(size / 1024 ** 3).toFixed(1)} GiB`;
}
