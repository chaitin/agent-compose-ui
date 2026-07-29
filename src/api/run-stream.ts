import type { RunAgentRequest } from '../gen/agentcompose/v2/agentcompose_pb.js';
import { runClient } from './client';

export function streamAgentRun(request: Partial<RunAgentRequest>, signal?: AbortSignal) {
  return runClient.runAgentStream(request, { signal });
}
