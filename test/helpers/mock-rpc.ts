import { vi } from 'vitest';

export type MockFn = ReturnType<typeof vi.fn>;

/**
 * 创建 mock service：每个指定方法是一个 vi.fn。
 * 用于依赖注入场景（如 toolbar-actions 的 saveProject(editorContent, client, options)），
 * 直接传入即可，无需 vi.mock 模块。
 */
export function createMockService<T extends string>(methods: readonly T[]): Record<T, MockFn> {
  return Object.fromEntries(methods.map(m => [m, vi.fn()])) as Record<T, MockFn>;
}

// 各 service 的方法清单（按实际 proto 调用点，见 TEST_PLAN 附录；不含全项目无调用的死代码 client）。
export const PROJECT_SERVICE_METHODS = ['validateProject', 'applyProject', 'getProject', 'listProjects', 'removeProject'] as const;
export const RUN_SERVICE_METHODS = ['runAgent', 'startRun', 'runAgentStream', 'runAttach', 'getRun', 'listRuns', 'followRunLogs', 'stopRun'] as const;
export const LOADER_SERVICE_METHODS = ['getLoader', 'listLoaderRuns', 'getLoaderRun', 'listLoaderEvents', 'runLoaderNow'] as const;
export const SESSION_SERVICE_METHODS = ['getSession', 'getSessionProxy', 'stopSession', 'resumeSession'] as const;
export const EXEC_SERVICE_METHODS = ['execStream'] as const;
export const KERNEL_SERVICE_METHODS = ['listCells', 'executeCell'] as const;
export const AGENT_SERVICE_METHODS = ['sendAgentMessage', 'listSessionEvents'] as const;
export const DASHBOARD_SERVICE_METHODS = ['watchDashboardOverview'] as const;
export const CONFIG_SERVICE_METHODS = ['getGlobalEnvConfig', 'updateGlobalEnvConfig'] as const;

export const mockProjectService = () => createMockService(PROJECT_SERVICE_METHODS);
export const mockRunService = () => createMockService(RUN_SERVICE_METHODS);
export const mockLoaderService = () => createMockService(LOADER_SERVICE_METHODS);
export const mockSessionService = () => createMockService(SESSION_SERVICE_METHODS);
