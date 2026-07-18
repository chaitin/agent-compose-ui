import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  ApplyProjectRequest, GetProjectRequest, ListRunsRequest, ProjectRef, ProjectSource,
  RunAgentRequest, RunSandboxCleanupPolicy, RunSource, ValidateProjectRequest,
} from '../../src/gen/agentcompose/v2/agentcompose_pb';
import { yamlToSpec } from '../../src/lib/yaml';
import { createLiveClients } from './api';

const stamp = new Date().toISOString().replace(/[-:.]/g, '').toLowerCase();
const batch = `e2e-yml10-${stamp}`;
const root = resolve('e2e/fixtures', batch);
const reportRoot = resolve('e2e/reports', batch);
const frontend = process.env.AGENT_COMPOSE_E2E_FRONTEND_URL ?? 'http://127.0.0.1:5174';
const daemon = process.env.AGENT_COMPOSE_E2E_DAEMON_URL ?? 'http://127.0.0.1:7410';
const clients = createLiveClients(daemon);
const image = 'ghcr.io/chaitin/agent-compose-guest:latest';
const rows: Array<Record<string, unknown>> = [];

function yaml(index: number): string {
  const name = `${batch}-${String(index).padStart(2, '0')}`;
  const marker = `${name}-bash-ok`;
  const additions = [
    'variables:\n  CASE_KIND: { value: basic-command }',
    'variables:\n  CASE_KIND: { value: environment }',
    'variables:\n  CASE_KIND: { value: unicode }',
    'variables:\n  CASE_KIND: { value: failure-record }',
    'network:\n  mode: default',
    'variables:\n  CASE_KIND: { value: pipeline }',
    'variables:\n  CASE_KIND: { value: scheduler }',
    'variables:\n  CASE_KIND: { value: system-prompt }',
    'variables:\n  CASE_KIND: { value: shell-expansion }',
    'variables:\n  CASE_KIND: { value: audit-trace }',
  ][index - 1];
  const scheduler = index === 7 ? `\n    scheduler:\n      enabled: true\n      sandbox_policy: sticky\n      triggers:\n        - name: daily-check\n          interval: 24h\n          prompt: ${marker}` : '';
  const systemPrompt = index === 8 ? '\n    system_prompt: 真实数据验收：保留中文配置' : '';
  return `name: ${name}\n${additions}\nagents:\n  worker-${index}:\n    provider: codex\n    image: ${image}\n    driver:\n      docker: {}\n    env:\n      YML_CASE: { value: \"${index}\" }\n      YML_MARKER: { value: ${marker} }${systemPrompt}${scheduler}\n`;
}

await mkdir(root, { recursive: true });
await mkdir(reportRoot, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

try {
  for (let index = 1; index <= 10; index++) {
    const filename = `${String(index).padStart(2, '0')}-case.yml`;
    const path = resolve(root, filename);
    const text = yaml(index);
    await writeFile(path, text, 'utf8');
    const diskText = await readFile(path, 'utf8');
    const parsed = yamlToSpec(diskText);
    if (parsed.error) throw new Error(`${filename}: ${parsed.error}`);
    const name = parsed.spec.name;
    const agent = `worker-${index}`;
    const marker = `${name}-bash-ok`;
    const source = new ProjectSource({ composePath: path, projectDir: root });
    const validated = await clients.project.validateProject(new ValidateProjectRequest({ spec: parsed.spec, source }));
    if (!validated.valid) throw new Error(`${filename}: ${validated.issues.map(x => x.message).join('; ')}`);
    const preview = await clients.project.applyProject(new ApplyProjectRequest({ spec: parsed.spec, source, dryRun: true }));
    const applied = await clients.project.applyProject(new ApplyProjectRequest({
      spec: parsed.spec, source, dryRun: false, expectedSpecHash: preview.revision?.specHash ?? '',
    }));
    const projectId = applied.project?.summary?.projectId ?? '';
    if (!projectId) throw new Error(`${filename}: missing project ID`);
    const saved = await clients.project.getProject(new GetProjectRequest({ project: new ProjectRef({ projectId }), includeSpec: true }));
    const failing = index === 4;
    const command = failing
      ? `/bin/bash -lc 'printf ${marker}-stderr >&2; exit 17'`
      : `/bin/bash -lc 'printf "%s|case=%s|pwd=%s" "$YML_MARKER" "$YML_CASE" "$PWD"'`;
    const run = await clients.run.runAgent(new RunAgentRequest({
      projectId, agentName: agent, command, source: RunSource.API,
      cleanupPolicy: RunSandboxCleanupPolicy.KEEP_RUNNING, clientRequestId: `${name}-run`,
    }));
    const runId = run.run?.summary?.runId ?? '';
    const sandboxId = run.run?.summary?.sandboxId ?? '';
    const output = run.run?.output ?? '';
    const runList = await clients.run.listRuns(new ListRunsRequest({ projectId, limit: 100 }));

    await page.addInitScript(({ projectId, text }) => localStorage.setItem(`editor:${projectId}`, text), { projectId, text });
    await page.goto(`${frontend}/#/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const filter = page.getByLabel('筛选智能体应用');
    await filter.fill(name);
    await page.getByRole('button', { name: new RegExp(name) }).first().click();
    await page.getByText(agent, { exact: true }).first().waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: '校验' }).click();
    try {
      await page.locator('.toast .message').last().waitFor({ state: 'visible', timeout: 60_000 });
      const toast = await page.locator('.toast .message').last().textContent();
      if (toast !== '校验通过') throw new Error(`browser validation returned: ${toast}`);
    } catch (error) {
      await page.screenshot({ path: resolve(reportRoot, `${filename}.validation-failure.png`), fullPage: true });
      const body = (await page.locator('body').innerText()).slice(0, 6000);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nPAGE BODY:\n${body}`);
    }
    await page.getByRole('button', { name: '保存' }).click();
    const applyOnly = page.getByText('仅应用配置，不构建镜像');
    try {
      await page.getByText('确认本次变更').waitFor({ timeout: 60_000 });
    } catch (error) {
      await page.screenshot({ path: resolve(reportRoot, `${filename}.save-failure.png`), fullPage: true });
      const toasts = await page.locator('.toast .message').allTextContents();
      const body = (await page.locator('body').innerText()).slice(0, 8000);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nTOASTS: ${JSON.stringify(toasts)}\nPAGE BODY:\n${body}`);
    }
    if (await applyOnly.isVisible()) await applyOnly.click();
    await page.getByRole('button', { name: '确认应用' }).click();
    await page.getByText('保存成功').last().waitFor({ timeout: 60_000 });
    await page.goto(`${frontend}/#/project/${projectId}/runtime`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByText(runId, { exact: true }).waitFor({ timeout: 60_000 });
    await page.getByText(runId, { exact: true }).click();
    await page.getByText(runId, { exact: true }).waitFor({ timeout: 60_000 });
    await page.screenshot({ path: resolve(reportRoot, `${filename}.run.png`), fullPage: true });

    let terminal = { attempted: false, pass: false, marker: '' };
    if (index === 1) {
      const terminalMarker = `${name}-terminal-bash-ok`;
      await page.goto(`${frontend}/#/project/${projectId}/sandbox/${sandboxId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.getByRole('tab', { name: 'Terminal' }).click();
      const textarea = page.locator('.xterm-helper-textarea');
      await textarea.waitFor({ state: 'visible', timeout: 60_000 });
      await textarea.fill(`bash -lc 'printf ${terminalMarker}'\n`);
      await page.getByText(terminalMarker, { exact: false }).waitFor({ timeout: 60_000 });
      await page.screenshot({ path: resolve(reportRoot, `${filename}.terminal.png`), fullPage: true });
      terminal = { attempted: true, pass: true, marker: terminalMarker };
    }

    const pass = diskText === text && saved.project?.spec?.name === name && Boolean(runId) && Boolean(sandboxId)
      && runList.runs.some(item => item.runId === runId)
      && (failing ? run.run?.summary?.exitCode === 17 && output.includes(`${marker}-stderr`) : output.includes(marker));
    rows.push({ index, filename, path, name, projectId, agent, command, runId, sandboxId,
      exitCode: run.run?.summary?.exitCode, output, savedSourcePath: saved.project?.summary?.sourcePath,
      runRecordCount: runList.runs.length, terminal, pass });
  }
} catch (error) {
  rows.push({ fatal: error instanceof Error ? error.stack ?? error.message : String(error), pass: false });
} finally {
  await browser.close();
}

const totals = { pass: rows.filter(row => row.pass === true).length, fail: rows.filter(row => row.pass !== true).length };
const result = { batch, generatedAt: new Date().toISOString(), daemon, frontend, fixtureRoot: root, reportRoot, totals, rows };
await writeFile(resolve(reportRoot, 'report.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
await writeFile(resolve(reportRoot, 'report.md'), [
  `# 10 YML 真实数据端到端验收：${batch}`, '',
  `- 汇总：${totals.pass} PASS / ${totals.fail} FAIL`,
  `- YML 留痕：\`${root}\``, `- 证据目录：\`${reportRoot}\``,
  '- 资源策略：项目、Run、Sandbox 全部保留供系统界面复核。', '',
  '| # | YML | Project ID | Run ID | Sandbox ID | Exit | Terminal | Result |',
  '|---:|---|---|---|---|---:|---|---|',
  ...rows.map((row: any) => row.fatal
    ? `| - | fatal | - | - | - | - | - | FAIL: ${String(row.fatal).replaceAll('|', '\\|')} |`
    : `| ${row.index} | ${row.filename} | ${row.projectId} | ${row.runId} | ${row.sandboxId} | ${row.exitCode} | ${row.terminal?.attempted ? (row.terminal.pass ? 'PASS' : 'FAIL') : 'N/A'} | ${row.pass ? 'PASS' : 'FAIL'} |`),
  '',
].join('\n'), 'utf8');
console.log(JSON.stringify(result, null, 2));
if (totals.fail || totals.pass !== 10) process.exitCode = 1;
