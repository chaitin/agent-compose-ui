import { createConnectTransport } from '@connectrpc/connect-web';
import { createClient } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import { authFetch } from './auth-fetch';

// Generated service descriptors
import {
  CacheService,
  CapabilityService,
  DashboardService,
  ExecService,
  ImageService,
  ProjectService,
  RunService,
  SandboxService,
  SettingsService,
  VolumeService,
} from '../gen/agentcompose/v2/agentcompose_connect';

const RPC_TIMEOUT_MS = 120_000; // 2 min — covers slow Docker pulls, gives user feedback sooner

const transport: Transport = createConnectTransport({
  baseUrl: window.location.origin,
  // Vite proxy forwards agentcompose v2 RPCs to the daemon at 127.0.0.1:7410.
  fetch: (input, init) => {
    const controller = new AbortController();
    const sourceSignal = init?.signal;
    let sourceAbortListener: (() => void) | undefined;
    if (sourceSignal) {
      if (sourceSignal.aborted) {
        // Signal already aborted — propagate immediately
        controller.abort(sourceSignal.reason);
      } else {
        sourceAbortListener = () => controller.abort(sourceSignal.reason);
        sourceSignal.addEventListener('abort', sourceAbortListener, { once: true });
      }
    }
    const timeout = setTimeout(() => controller.abort(new DOMException('RPC timeout', 'TimeoutError')), RPC_TIMEOUT_MS);
    return authFetch(input, { ...init, signal: controller.signal })
      .finally(() => {
        clearTimeout(timeout);
        if (sourceSignal && sourceAbortListener) {
          sourceSignal.removeEventListener('abort', sourceAbortListener);
        }
      });
  },
});

export const projectService = createClient(ProjectService, transport);
export const runService = createClient(RunService, transport);
export const execService = createClient(ExecService, transport);
export const sandboxService = createClient(SandboxService, transport);
export const imageService = createClient(ImageService, transport);
export const cacheService = createClient(CacheService, transport);
export const volumeService = createClient(VolumeService, transport);
export const dashboardService = createClient(DashboardService, transport);
export const settingsService = createClient(SettingsService, transport);
export const capabilityService = createClient(CapabilityService, transport);
