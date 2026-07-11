import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';

import {
  CapabilityService,
  DashboardService,
  ExecService,
  ProjectService,
  RunService,
  SandboxService,
  SettingsService,
} from '../gen/agentcompose/v2/agentcompose_connect.js';
import { HealthService } from '../gen/health/v1/health_connect.js';
import { connectBaseUrl } from '../paths';

const grpcWebTransport = createGrpcWebTransport({
  baseUrl: connectBaseUrl(),
});

export const projectClient = createClient(ProjectService, grpcWebTransport);
export const sandboxClient = createClient(SandboxService, grpcWebTransport);
export const settingsClient = createClient(SettingsService, grpcWebTransport);
export const capabilityClient = createClient(CapabilityService, grpcWebTransport);
export const dashboardClient = createClient(DashboardService, grpcWebTransport);
export const healthClient = createClient(HealthService, grpcWebTransport);
export const runClient = createClient(RunService, grpcWebTransport);
export const execClient = createClient(ExecService, grpcWebTransport);
