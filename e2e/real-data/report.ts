import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type CaseStatus = 'PASS' | 'FAIL' | 'UNAVAILABLE';

export interface FieldAssertion {
  field: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

export interface CaseOperation {
  actual: unknown;
  assertions: FieldAssertion[];
}

export interface CaseResult {
  id: string;
  area: string;
  input: unknown;
  expected: unknown;
  actual: unknown;
  assertions: FieldAssertion[];
  status: CaseStatus;
  elapsedMs: number;
}

export interface SuiteResult {
  batchId: string;
  startedAt: string;
  finishedAt?: string;
  cases: CaseResult[];
  totals?: Record<CaseStatus, number>;
}

const secretPattern = /(api.?key|token|password|authorization|credential|secret)/i;

export function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    secretPattern.test(key) ? '[REDACTED]' : sanitize(item, seen),
  ]));
}

export class CaseRecorder {
  readonly result: SuiteResult;

  constructor(batchId: string) {
    this.result = { batchId, startedAt: new Date().toISOString(), cases: [] };
  }

  async run(
    id: string,
    area: string,
    input: unknown,
    expected: unknown,
    operation: () => Promise<CaseOperation>,
  ): Promise<void> {
    const started = performance.now();
    try {
      const value = await operation();
      const status = value.assertions.every((assertion) => assertion.pass) ? 'PASS' : 'FAIL';
      this.result.cases.push({
        id,
        area,
        input: sanitize(input),
        expected: sanitize(expected),
        actual: sanitize(value.actual),
        assertions: sanitize(value.assertions) as FieldAssertion[],
        status,
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      });
    } catch (error) {
      this.result.cases.push({
        id,
        area,
        input: sanitize(input),
        expected: sanitize(expected),
        actual: { error: error instanceof Error ? error.message : String(error) },
        assertions: [],
        status: 'FAIL',
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      });
    }
  }

  addUnavailable(id: string, area: string, input: unknown, expected: unknown, actual: unknown): void {
    this.result.cases.push({ id, area, input: sanitize(input), expected: sanitize(expected), actual: sanitize(actual), assertions: [], status: 'UNAVAILABLE', elapsedMs: 0 });
  }

  finalize(): SuiteResult {
    this.result.finishedAt = new Date().toISOString();
    this.result.totals = { PASS: 0, FAIL: 0, UNAVAILABLE: 0 };
    for (const item of this.result.cases) this.result.totals[item.status] += 1;
    return this.result;
  }
}

function markdownCell(value: unknown): string {
  return `\`${JSON.stringify(value).replaceAll('|', '\\|').replaceAll('\n', ' ')}\``;
}

export async function writeReports(result: SuiteResult, directory: string): Promise<{ json: string; markdown: string }> {
  await mkdir(directory, { recursive: true });
  const jsonPath = join(directory, `${result.batchId}.json`);
  const markdownPath = join(directory, `${result.batchId}.md`);
  const rows = result.cases.map((item) => `| ${item.area}/${item.id} | ${markdownCell(item.expected)} | ${markdownCell(item.actual)} | ${item.status} |`);
  const markdown = [
    `# Agent Compose 真实数据测试报告：${result.batchId}`,
    '',
    `- 开始：${result.startedAt}`,
    `- 结束：${result.finishedAt ?? ''}`,
    `- 汇总：${JSON.stringify(result.totals ?? {})}`,
    '',
    '| 功能 | 预期数据 | 实际数据 | 结果 |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## 逐字段断言',
    '',
    ...result.cases.flatMap((item) => [
      `### ${item.area}/${item.id}`,
      '',
      ...item.assertions.map((assertion) => `- ${assertion.pass ? 'PASS' : 'FAIL'} ${assertion.field}: expected=${JSON.stringify(assertion.expected)}, actual=${JSON.stringify(assertion.actual)}`),
      '',
    ]),
  ].join('\n');
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8'),
    writeFile(markdownPath, markdown, 'utf8'),
  ]);
  return { json: jsonPath, markdown: markdownPath };
}
