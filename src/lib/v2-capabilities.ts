export type V2CapabilityId =
  | 'session-lifecycle'
  | 'loader-runs';

export const V2_CAPABILITIES: Record<V2CapabilityId, { available: false; reason: string }> = {
  'session-lifecycle': { available: false, reason: 'v2 未提供独立 Session 清单与停止接口；交互环境由 Sandbox 承载，文件通过 Exec、恢复通过 Run 复用、Jupyter 通过 HTTP 代理提供。' },
  'loader-runs': { available: false, reason: 'v2 未提供独立 Loader Run 服务；计划执行由 Scheduler、运行进度由 Run Event 承载。' },
};
