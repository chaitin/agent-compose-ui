import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cleanupFixture, createLiveClients, runApiCases, type RealDataContext } from './api';
import { buildFixture, createLedger } from './fixtures';
import { CaseRecorder, writeReports } from './report';

const fixture = buildFixture(process.env.AGENT_COMPOSE_E2E_BATCH_ID);
const recorder = new CaseRecorder(fixture.batchId);
const reportDirectory = resolve(process.env.AGENT_COMPOSE_E2E_REPORT_DIR ?? 'e2e/reports');
const context: RealDataContext = {
  daemonUrl: process.env.AGENT_COMPOSE_E2E_DAEMON_URL ?? 'http://127.0.0.1:7410',
  frontendUrl: process.env.AGENT_COMPOSE_E2E_FRONTEND_URL ?? 'http://127.0.0.1:5174',
  fixture,
  ledger: createLedger(fixture.batchId),
  recorder,
  clients: createLiveClients(process.env.AGENT_COMPOSE_E2E_DAEMON_URL ?? 'http://127.0.0.1:7410'),
  projectId: '',
  successfulRunId: '',
  failedRunId: '',
  stoppedRunId: '',
};

let paths: { json: string; markdown: string } | undefined;
try {
  await mkdir(reportDirectory, { recursive: true });
  await runApiCases(context);
  if (!process.argv.includes('--api-only')) {
    const { runBrowserCases } = await import('./browser');
    await runBrowserCases(context, reportDirectory);
  }
} catch (error) {
  await recorder.run('orchestrator', '测试框架', {}, { completedWithoutUnhandledError: true }, async () => ({
    actual: { error: error instanceof Error ? error.message : String(error) },
    assertions: [{ field: 'completedWithoutUnhandledError', expected: true, actual: false, pass: false }],
  }));
} finally {
  await cleanupFixture(context);
  const result = recorder.finalize();
  paths = await writeReports(result, reportDirectory);
  console.log(`\n真实数据测试批次: ${fixture.batchId}`);
  console.log(`结果汇总: ${JSON.stringify(result.totals)}`);
  console.log(`JSON: ${paths.json}`);
  console.log(`Markdown: ${paths.markdown}`);
  for (const item of result.cases) console.log(`${item.status.padEnd(11)} ${item.area}/${item.id}`);
  if (result.cases.some((item) => item.status === 'FAIL')) process.exitCode = 1;
}
