import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaseRecorder, writeReports } from './report';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('real-data E2E reporting', () => {
  test('records declared expected and actual values for a passing case', async () => {
    const recorder = new CaseRecorder('e2e-fixed');

    await recorder.run('health', 'service', { path: '/api/version' }, { status: 200 }, async () => ({
      actual: { status: 200 },
      assertions: [{ field: 'status', expected: 200, actual: 200, pass: true }],
    }));

    expect(recorder.result.cases).toHaveLength(1);
    expect(recorder.result.cases[0].status).toBe('PASS');
    expect(recorder.result.cases[0].expected).toEqual({ status: 200 });
    expect(recorder.result.cases[0].actual).toEqual({ status: 200 });
  });

  test('sanitizes secret-shaped fields recursively', async () => {
    const recorder = new CaseRecorder('e2e-fixed');

    await recorder.run('secret', 'safety', { apiKey: 'secret', nested: { token: 'token' } }, {}, async () => ({
      actual: { password: 'password' },
      assertions: [],
    }));

    expect(recorder.result.cases[0].input).toEqual({ apiKey: '[REDACTED]', nested: { token: '[REDACTED]' } });
    expect(recorder.result.cases[0].actual).toEqual({ password: '[REDACTED]' });
  });

  test('writes JSON and Markdown with expected and actual columns', async () => {
    const recorder = new CaseRecorder('e2e-fixed');
    await recorder.run('health', 'service', {}, { ok: true }, async () => ({
      actual: { ok: true },
      assertions: [{ field: 'ok', expected: true, actual: true, pass: true }],
    }));
    const directory = await mkdtemp(join(tmpdir(), 'agent-compose-e2e-report-'));
    directories.push(directory);

    const paths = await writeReports(recorder.finalize(), directory);
    const markdown = await readFile(paths.markdown, 'utf8');
    const json = JSON.parse(await readFile(paths.json, 'utf8'));

    expect(markdown).toContain('| 功能 | 预期数据 | 实际数据 | 结果 |');
    expect(json.cases[0]).toMatchObject({ expected: { ok: true }, actual: { ok: true }, status: 'PASS' });
  });
});
