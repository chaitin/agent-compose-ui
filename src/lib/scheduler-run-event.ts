export function schedulerRunEventId(payloadJson: string): string {
  try {
    const value = JSON.parse(payloadJson) as { payload?: { eventId?: unknown } };
    return typeof value.payload?.eventId === 'string' ? value.payload.eventId.trim() : '';
  } catch {
    return '';
  }
}
