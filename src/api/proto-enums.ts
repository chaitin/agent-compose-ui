import {
  SandboxStatus,
  SchedulerConcurrencyPolicy,
  SchedulerSandboxPolicy,
  TriggerKind,
} from '../gen/agentcompose/v2/agentcompose_pb.js';

export function sandboxStatusFromString(value: string): SandboxStatus {
  switch (value.trim().toLowerCase()) {
    case 'pending':
      return SandboxStatus.PENDING;
    case 'running':
      return SandboxStatus.RUNNING;
    case 'stopped':
      return SandboxStatus.STOPPED;
    case 'failed':
      return SandboxStatus.FAILED;
    case 'deleting':
      return SandboxStatus.DELETING;
    default:
      return SandboxStatus.UNSPECIFIED;
  }
}

export function sandboxStatusToString(value: SandboxStatus): string {
  return ['unknown', 'pending', 'running', 'stopped', 'failed', 'deleting'][value] ?? 'unknown';
}

export function schedulerSandboxPolicyFromString(value: string): SchedulerSandboxPolicy {
  return value.trim().toLowerCase() === 'sticky' ? SchedulerSandboxPolicy.STICKY : SchedulerSandboxPolicy.NEW;
}

export function schedulerSandboxPolicyToString(value: SchedulerSandboxPolicy): string {
  return value === SchedulerSandboxPolicy.STICKY ? 'sticky' : 'new';
}

export function schedulerConcurrencyPolicyFromString(value: string): SchedulerConcurrencyPolicy {
  return value.trim().toLowerCase() === 'parallel'
    ? SchedulerConcurrencyPolicy.PARALLEL
    : SchedulerConcurrencyPolicy.SKIP;
}

export function schedulerConcurrencyPolicyToString(value: SchedulerConcurrencyPolicy): string {
  return value === SchedulerConcurrencyPolicy.PARALLEL ? 'parallel' : 'skip';
}

export function triggerKindFromString(value: string): TriggerKind {
  switch (value.trim().toLowerCase()) {
    case 'cron':
      return TriggerKind.CRON;
    case 'interval':
      return TriggerKind.INTERVAL;
    case 'timeout':
      return TriggerKind.TIMEOUT;
    case 'event':
      return TriggerKind.EVENT;
    default:
      return TriggerKind.UNSPECIFIED;
  }
}

export function triggerKindToString(value: TriggerKind): string {
  return ['unknown', 'cron', 'interval', 'timeout', 'event'][value] ?? 'unknown';
}
