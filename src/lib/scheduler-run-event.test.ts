import { expect, test } from 'vitest';
import { schedulerRunEventId } from './scheduler-run-event';

test('reads and trims the triggering Event ID from a Scheduler Run payload', () => {
  expect(schedulerRunEventId('{"payload":{"eventId":"  evt_123  "}}')).toBe('evt_123');
});

test.each(['', '{', '{}', '{"payload":{}}', '{"payload":{"eventId":42}}'])(
  'returns empty for an unusable Scheduler Run payload: %s',
  payload => {
    expect(schedulerRunEventId(payload)).toBe('');
  },
);
