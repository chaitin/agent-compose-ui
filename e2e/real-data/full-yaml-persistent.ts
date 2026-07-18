import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  ApplyProjectRequest, GetProjectRequest, GetSchedulerRequest, InspectImageRequest,
  ListRunsRequest, ProjectRef, ProjectSource, RunAgentRequest, RunSandboxCleanupPolicy,
  RunSource, ValidateProjectRequest, ImageStoreKind,
} from '../../src/gen/agentcompose/v2/agentcompose_pb';
import { yamlToSpec } from '../../src/lib/yaml';
import { createLiveClients } from './api';

const fixtureDirectory = resolve('e2e/fixtures/full-yaml');
const yamlPath = resolve(fixtureDirectory, 'agent-compose.yml');
const scriptPath = resolve(fixtureDirectory, 'scheduler.js');
const reportDirectory = resolve('e2e/reports');
const frontendUrl = process.env.AGENT_COMPOSE_E2E_FRONTEND_URL ?? 'http://127.0.0.1:5174';
const daemonUrl = process.env.AGENT_COMPOSE_E2E_DAEMON_URL ?? 'http://127.0.0.1:7410';
const projectName = 'e2e-yaml-full-20260715t232500z';
const clients = createLiveClients(daemonUrl);
const cases: Array<{ name: string; expected: unknown; actual: unknown; pass: boolean }> = [];
const record = (name: string, expected: unknown, actual: unknown, pass: boolean) => cases.push({ name, expected, actual, pass });

const yamlText = await readFile(yamlPath, 'utf8');
const schedulerScript = await readFile(scriptPath, 'utf8');
const expandedYaml = yamlText.replace(`$ref:${projectName}/scheduler.js`, JSON.stringify(schedulerScript));
const parsed = yamlToSpec(expandedYaml);
if (parsed.error) throw new Error(parsed.error);

const scriptBase = `${frontendUrl}/script-api/v1`;
const folderResponse = await fetch(`${scriptBase}/folders`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: projectName }),
});
if (![201, 409].includes(folderResponse.status)) throw new Error(`script folder: ${folderResponse.status}`);
const currentScriptResponse = await fetch(`${scriptBase}/files?path=${encodeURIComponent(`${projectName}/scheduler.js`)}`);
const currentScript = currentScriptResponse.ok ? await currentScriptResponse.json() as { sha256?: string } : undefined;
const fileResponse = await fetch(`${scriptBase}/files`, {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: `${projectName}/scheduler.js`, content: schedulerScript, expectedSha256: currentScript?.sha256 ?? null }),
});
if (!fileResponse.ok) throw new Error(`script file: ${fileResponse.status}`);
record('referenced scheduler script persisted', 200, fileResponse.status, fileResponse.ok);

const source = new ProjectSource({ composePath: yamlPath, projectDir: fixtureDirectory });
const validation = await clients.project.validateProject(new ValidateProjectRequest({ spec: parsed.spec, source }));
record('real YAML validates', { valid: true, issues: 0 }, { valid: validation.valid, issues: validation.issues.length }, validation.valid && validation.issues.length === 0);
if (!validation.valid) throw new Error(`validation failed: ${validation.issues.map(issue => issue.message).join('; ')}`);

const preview = await clients.project.applyProject(new ApplyProjectRequest({ spec: parsed.spec, source, dryRun: true }));
record('dry-run preview produced revision', true, Boolean(preview.revision?.specHash), Boolean(preview.revision?.specHash));
const applied = await clients.project.applyProject(new ApplyProjectRequest({
  spec: parsed.spec, source, dryRun: false, expectedSpecHash: preview.revision?.specHash ?? '',
}));
const projectId = applied.project?.summary?.projectId ?? '';
record('YAML applied and saved', true, { applied: applied.applied, unchanged: applied.unchanged, projectId }, Boolean(projectId) && (applied.applied || applied.unchanged));
if (!projectId) throw new Error('Apply omitted project ID');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.addInitScript(({ projectId, yamlText }) => {
  localStorage.setItem(`editor:${projectId}`, yamlText);
}, { projectId, yamlText });
try {
  await page.goto(`${frontendUrl}/#/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const filter = page.getByLabel('筛选智能体应用');
  await filter.fill(projectName);
  await page.getByRole('button', { name: new RegExp(projectName) }).first().click();
  await page.getByRole('button', { name: '校验' }).click();
  await page.getByText('校验通过').waitFor({ timeout: 60_000 });
  record('browser editor validates exact YAML', true, true, true);

  await page.getByRole('button', { name: '启用' }).click();
  const applyAction = page.getByRole('button', { name: /^(构建并应用|确认应用)$/ });
  await applyAction.waitFor({ timeout: 60_000 });
  const applyActionLabel = await applyAction.textContent();
  await applyAction.click();
  await page.getByText('保存成功').waitFor({ timeout: 300_000 });
  record('browser saved application from real preview', true, applyActionLabel, true);

  await page.getByRole('button', { name: '启用' }).click();
  await page.getByText('当前配置与已保存版本一致。').waitFor({ timeout: 60_000 });
  const skip = page.getByText('仅应用配置，不构建镜像');
  if (await skip.isVisible()) await skip.click();
  await page.getByRole('button', { name: '确认应用' }).click();
  await page.getByText('保存成功').waitFor({ timeout: 60_000 });
  record('unchanged re-save reports zero real changes', 0, 0, true);
  await page.screenshot({ path: resolve(reportDirectory, `${projectName}-saved.png`), fullPage: true });
} finally {
  await browser.close();
}

const saved = await clients.project.getProject(new GetProjectRequest({ project: new ProjectRef({ projectId }), includeSpec: true }));
const savedAgents = saved.project?.spec?.agents ?? [];
record('saved API truth retains all agents', 4, savedAgents.length, savedAgents.length === 4);
const savedWorkspace = saved.project?.spec?.workspaces.find(item => item.name === 'fixture-workspace');
const buildAgentWorkspace = savedAgents.find(agent => agent.name === 'build-workspace-agent')?.workspace;
record('workspace retained', { named: 'fixture-workspace', path: 'workspace' }, {
  named: savedWorkspace?.name, path: buildAgentWorkspace?.path,
}, savedWorkspace?.name === 'fixture-workspace' && buildAgentWorkspace?.path === 'workspace');
record('build retained', 'runtime', savedAgents.find(agent => agent.name === 'build-workspace-agent')?.build?.target, savedAgents.find(agent => agent.name === 'build-workspace-agent')?.build?.target === 'runtime');
record('prompt retained', true, savedAgents.find(agent => agent.name === 'prompt-agent')?.systemPrompt, savedAgents.find(agent => agent.name === 'prompt-agent')?.systemPrompt.includes('exactly the marker') ?? false);
record('script retained', true, savedAgents.find(agent => agent.name === 'script-agent')?.scheduler?.script.includes('yaml-script-main-ok'), savedAgents.find(agent => agent.name === 'script-agent')?.scheduler?.script.includes('yaml-script-main-ok') ?? false);

const triggerScheduler = await clients.project.getScheduler(new GetSchedulerRequest({ project: new ProjectRef({ projectId }), agentName: 'trigger-agent' }));
record('declarative triggers materialized', 4, triggerScheduler.triggers.length, triggerScheduler.triggers.length === 4);
const scriptScheduler = await clients.project.getScheduler(new GetSchedulerRequest({ project: new ProjectRef({ projectId }), agentName: 'script-agent' }));
record('script trigger materialized', true, scriptScheduler.triggers.map(trigger => trigger.triggerId), scriptScheduler.triggers.some(trigger => trigger.triggerId.includes('script-interval-check')));

async function cliSchedulerTrigger(agent: string, trigger: string, extra: string[]): Promise<string> {
  const process = Bun.spawn([
    '/root/agent/agent-compose/build/agent-compose', '--host', daemonUrl, '--file',
    yamlPath, 'scheduler', 'trigger', agent, trigger,
    '--keep-running', '--json', ...extra,
  ], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`scheduler trigger ${agent}/${trigger}: ${stderr || stdout}`);
  return stdout;
}

const scriptTriggerOutput = await cliSchedulerTrigger('script-agent', 'script-interval-check', ['--payload', '{"source":"full-yaml-e2e"}']);
record('scheduler script executes', 'yaml-script-trigger-ok', scriptTriggerOutput, scriptTriggerOutput.includes('yaml-script-trigger-ok'));
const declarativeMarker = `${projectName}-trigger-prompt-ok`;
const declarativeTriggerOutput = await cliSchedulerTrigger('trigger-agent', 'interval-check', ['--prompt', `Reply with exactly ${declarativeMarker}`]);
record('declarative prompt trigger executes', declarativeMarker, declarativeTriggerOutput, declarativeTriggerOutput.includes(declarativeMarker));

const commandMarker = 'yaml-build-workspace-env-ok';
const command = `test "${'$'}E2E_VISIBLE" = visible-value && test "${'$'}(cat /etc/agent-compose-yaml-build-marker)" = yaml-build-config-ok && test "${'$'}(cat workspace-marker.txt)" = yaml-workspace-config-ok && printf ${commandMarker}`;
const commandRun = await clients.run.runAgent(new RunAgentRequest({
  projectId, agentName: 'build-workspace-agent', command: `/bin/sh -lc '${command}'`, source: RunSource.API,
  cleanupPolicy: RunSandboxCleanupPolicy.KEEP_RUNNING, clientRequestId: `${projectName}-command`,
}));
record('build/workspace/env execution', commandMarker, commandRun.run?.output, commandRun.run?.output.includes(commandMarker) ?? false);

const promptMarker = `${projectName}-prompt-ok`;
const promptRun = await clients.run.runAgent(new RunAgentRequest({
  projectId, agentName: 'prompt-agent', prompt: `Reply with exactly ${promptMarker}`, source: RunSource.API,
  cleanupPolicy: RunSandboxCleanupPolicy.KEEP_RUNNING, clientRequestId: `${projectName}-prompt`,
}));
record('prompt execution', promptMarker, promptRun.run?.output, promptRun.run?.output.includes(promptMarker) ?? false);

const image = await clients.image.inspectImage(new InspectImageRequest({ imageRef: 'agent-compose-e2e-full:20260715', store: ImageStoreKind.DOCKER_DAEMON }));
record('built image inspectable', true, image.image?.imageId, Boolean(image.image?.imageId));
const runs = await clients.run.listRuns(new ListRunsRequest({ projectId, limit: 100 }));
const runIds = runs.runs.map(run => run.runId);
record('run records retained', true, runIds, runIds.includes(commandRun.run?.summary?.runId ?? '') && runIds.includes(promptRun.run?.summary?.runId ?? ''));

await mkdir(reportDirectory, { recursive: true });
const result = {
  projectName, projectId, yamlPath, sourcePath: saved.project?.summary?.sourcePath,
  commandRunId: commandRun.run?.summary?.runId, promptRunId: promptRun.run?.summary?.runId,
  commandSandboxId: commandRun.run?.summary?.sandboxId, promptSandboxId: promptRun.run?.summary?.sandboxId,
  cases, totals: { pass: cases.filter(item => item.pass).length, fail: cases.filter(item => !item.pass).length },
};
const reportBase = resolve(reportDirectory, projectName);
await writeFile(`${reportBase}.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
await writeFile(`${reportBase}.md`, [
  `# Full YAML persistent E2E: ${projectName}`, '',
  `- Project ID: \`${projectId}\``, `- YAML: \`${yamlPath}\``,
  `- Command Run: \`${result.commandRunId}\``, `- Prompt Run: \`${result.promptRunId}\``,
  `- Summary: ${result.totals.pass} PASS / ${result.totals.fail} FAIL`, '',
  '| Case | Expected | Actual | Result |', '|---|---|---|---|',
  ...cases.map(item => `| ${item.name} | \`${JSON.stringify(item.expected)}\` | \`${JSON.stringify(item.actual)}\` | ${item.pass ? 'PASS' : 'FAIL'} |`),
  '', 'Resources are intentionally retained for UI inspection.', '',
].join('\n'), 'utf8');
console.log(JSON.stringify(result, null, 2));
if (result.totals.fail) process.exitCode = 1;
