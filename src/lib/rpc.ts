import { createConnectTransport } from '@connectrpc/connect-web';
import { createClient } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import { transportFetch } from './rpc-fetch';

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

const transport: Transport = createConnectTransport({
  baseUrl: window.location.origin,
  // Vite proxy forwards agentcompose v2 RPCs to the daemon at 127.0.0.1:7410.
  fetch: transportFetch,
});

const projectTransport: Transport = createConnectTransport({
  baseUrl: window.location.origin,
  useBinaryFormat: false,
  fetch: transportFetch,
});

// Runtime reads do not need the gateway's JSON spec-rewrite path. Keeping
// these calls binary routes them through the daemon proxy without coupling
// operational screens to project environment resolution.
const runtimeProjectTransport: Transport = createConnectTransport({
  baseUrl: window.location.origin,
  useBinaryFormat: true,
  fetch: transportFetch,
});

export const projectService = createClient(ProjectService, projectTransport);
export const runtimeProjectService = createClient(ProjectService, runtimeProjectTransport);
export const runService = createClient(RunService, transport);
export const execService = createClient(ExecService, transport);
export const sandboxService = createClient(SandboxService, transport);
export const imageService = createClient(ImageService, transport);
export const cacheService = createClient(CacheService, transport);
export const volumeService = createClient(VolumeService, transport);
export const dashboardService = createClient(DashboardService, transport);
export const settingsService = createClient(SettingsService, projectTransport);
export const capabilityService = createClient(CapabilityService, transport);
