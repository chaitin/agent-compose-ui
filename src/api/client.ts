import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';

import {
  AgentDefinitionService,
  AgentService,
  CapabilityService,
  ConfigService,
  DashboardService,
  KernelService,
  LLMService,
  LoaderService,
  SessionService,
} from '@chaitin-ai/agent-compose-client/agentcompose/v1/agentcompose_connect.js';
import { RunService } from '@chaitin-ai/agent-compose-client/agentcompose/v2/agentcompose_connect.js';
import { HealthService } from '@chaitin-ai/agent-compose-client/health/v1/health_connect.js';
import { connectBaseUrl } from '../paths';

const grpcWebTransport = createGrpcWebTransport({
  baseUrl: connectBaseUrl(),
});

export const sessionClient = createClient(SessionService, grpcWebTransport);
export const kernelClient = createClient(KernelService, grpcWebTransport);
export const agentClient = createClient(AgentService, grpcWebTransport);
export const agentDefinitionClient = createClient(AgentDefinitionService, grpcWebTransport);
export const llmClient = createClient(LLMService, grpcWebTransport);
export const loaderClient = createClient(LoaderService, grpcWebTransport);
export const configClient = createClient(ConfigService, grpcWebTransport);
export const capabilityClient = createClient(CapabilityService, grpcWebTransport);
export const dashboardClient = createClient(DashboardService, grpcWebTransport);
export const healthClient = createClient(HealthService, grpcWebTransport);
export const runClient = createClient(RunService, grpcWebTransport);
