export type TimestampValue = {
  seconds: bigint;
  nanos: number;
};

export function timestampToISOString(value: TimestampValue | string | null | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return new Date(Number(value.seconds) * 1000 + value.nanos / 1e6).toISOString();
}
