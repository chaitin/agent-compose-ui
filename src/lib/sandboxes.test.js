import { expect, test } from 'bun:test';
import { formatMetric, sandboxJupyterPath } from './sandboxes';

test('formats available and unavailable metrics', () => {
  expect(formatMetric({ value: 12.34, unit: '%' })).toBe('12.3%');
  expect(formatMetric({ value: 0, unit: 'percent' })).toBe('0.0%');
  expect(formatMetric({ value: 628.1, unit: 'seconds' })).toBe('10m 28s');
  expect(formatMetric({ value: 90061, unit: 'seconds' })).toBe('1d 1h 1m');
  expect(formatMetric({ value: 790528, unit: 'bytes' })).toBe('772.0 KB');
  expect(formatMetric({ value: 8352129024, unit: 'bytes' })).toBe('7.8 GB');
  expect(formatMetric({ message: 'driver unsupported' })).toBe('不可用');
});

test('builds an encoded same-origin Jupyter proxy path', () => {
  expect(sandboxJupyterPath('sandbox/a b')).toBe('/jupyter/sandbox%2Fa%20b');
  expect(sandboxJupyterPath('sandbox-1', '/agent-compose/jupyter/')).toBe('/agent-compose/jupyter/sandbox-1');
});
