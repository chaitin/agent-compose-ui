import { SandboxStatus } from '../gen/agentcompose/v2/agentcompose_pb';

/**
 * Convert a protobuf Timestamp (seconds/nanos) to an ISO string.
 * Returns an empty string when the timestamp is absent.
 */
export function timestampToIso(ts?: { seconds: bigint; nanos: number }): string {
  if (!ts) return '';
  return new Date(Number(ts.seconds) * 1000 + ts.nanos / 1_000_000).toISOString();
}

/**
 * Convert an ISO string to a protobuf Timestamp-shaped object (seconds/nanos).
 * Returns undefined when the input is empty or unparseable. The plain object is
 * accepted by request constructors as a PartialMessage<Timestamp>.
 */
export function isoToTimestamp(iso: string): { seconds: bigint; nanos: number } | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return { seconds: BigInt(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
}

/** Normalize a SandboxStatus enum to a lowercase string label. */
export function sandboxStatusString(status?: SandboxStatus): string {
  switch (status) {
    case SandboxStatus.PENDING:
      return 'pending';
    case SandboxStatus.RUNNING:
      return 'running';
    case SandboxStatus.STOPPED:
      return 'stopped';
    case SandboxStatus.FAILED:
      return 'failed';
    case SandboxStatus.DELETING:
      return 'deleting';
    default:
      return 'unspecified';
  }
}
