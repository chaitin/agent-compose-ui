import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { GetProjectRequest, GetRunRequest, InspectImageRequest, ImageStoreKind, ListSandboxesRequest, ProjectRef, RunStatus } from '../../src/gen/agentcompose/v2/agentcompose_pb';
import { exact, predicate, type RealDataContext } from './api';

async function evidence(page: Page, directory: string, id: string): Promise<void> {
  const target = join(directory, 'evidence');
  await mkdir(target, { recursive: true });
  await Promise.all([
    page.screenshot({ path: join(target, `${id}.png`), fullPage: true }),
    page.locator('body').innerText().then((text) => writeFile(join(target, `${id}.txt`), text.replace(/(api.?key|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]'), 'utf8')),
  ]);
}

async function pageText(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('body').waitFor({ state: 'visible' });
  return page.locator('body').innerText();
}

export async function runBrowserCases(context: RealDataContext, reportDirectory: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const base = context.frontendUrl;
  try {
    await context.recorder.run('health', '前端', { url: base }, { title: 'Agent Compose Console', bodyVisible: true }, async () => {
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const title = await page.title();
      const visible = await page.locator('body').isVisible();
      return { actual: { title, bodyVisible: visible }, assertions: [exact('title', 'Agent Compose Console', title), exact('bodyVisible', true, visible)] };
    });

    await context.recorder.run('filter-and-open', '前端项目', { filter: context.fixture.projectName }, { sidebarName: context.fixture.projectName, agents: ['deterministic-agent', 'llm-agent'] }, async () => {
      await page.goto(`${base}/#/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const filter = page.getByLabel('筛选智能体应用');
      await filter.fill(context.fixture.projectName);
      const projectButton = page.getByRole('button', { name: new RegExp(context.fixture.projectName) }).first();
      await projectButton.waitFor({ state: 'visible', timeout: 30_000 });
      await projectButton.click();
      await page.getByText('deterministic-agent', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
      const text = await page.locator('body').innerText();
      const assertions = [exact('sidebarName', true, text.includes(context.fixture.projectName)), exact('deterministicAgent', true, text.includes('deterministic-agent')), exact('llmAgent', true, text.includes('llm-agent'))];
      if (assertions.some((item) => !item.pass)) await evidence(page, reportDirectory, 'frontend-project');
      return { actual: { url: page.url(), containsProject: text.includes(context.fixture.projectName), containsDeterministicAgent: text.includes('deterministic-agent'), containsLlmAgent: text.includes('llm-agent') }, assertions };
    });

    await context.recorder.run('detail-api-truth', '前端运行', { runId: context.successfulRunId }, { status: '成功', output: context.fixture.stdoutMarker, exitCode: '0' }, async () => {
      const truth = await context.clients.run.getRun(new GetRunRequest({ projectId: context.projectId, runId: context.successfulRunId }));
      const expectedStatus = RunStatus[truth.run?.summary?.status ?? 0] === 'SUCCEEDED' ? '成功' : RunStatus[truth.run?.summary?.status ?? 0];
      await page.goto(`${base}/#/project/${context.projectId}/agent/deterministic-agent/run/${context.successfulRunId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.getByText(expectedStatus, { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
      await page.getByText(context.fixture.stdoutMarker, { exact: false }).first().waitFor({ state: 'visible', timeout: 30_000 });
      const text = await page.locator('body').innerText();
      const assertions = [exact('status', true, text.includes(expectedStatus)), exact('output', true, text.includes(context.fixture.stdoutMarker)), exact('exitCode', true, text.includes('0')), exact('runId', true, text.includes(context.successfulRunId) || page.url().includes(context.successfulRunId))];
      if (assertions.some((item) => !item.pass)) await evidence(page, reportDirectory, 'frontend-run-detail');
      return { actual: { apiStatus: RunStatus[truth.run?.summary?.status ?? 0], visibleStatus: text.includes(expectedStatus), visibleOutput: text.includes(context.fixture.stdoutMarker), visibleExitCode: text.includes('0'), url: page.url() }, assertions };
    });

    await context.recorder.run('image-api-truth', '前端镜像', { query: context.fixture.image }, { reference: context.fixture.image, platform: 'linux/amd64' }, async () => {
      const truth = await context.clients.image.inspectImage(new InspectImageRequest({ imageRef: context.fixture.image, store: ImageStoreKind.DOCKER_DAEMON }));
      await page.goto(`${base}/#/resources/images`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const filter = page.getByLabel('筛选镜像');
      await filter.fill(context.fixture.image);
      const imageReference = page.getByText(context.fixture.image, { exact: true }).first();
      await imageReference.waitFor({ state: 'visible', timeout: 30_000 });
      await imageReference.click();
      await page.getByText('镜像详情', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
      const text = await page.locator('body').innerText();
      const platform = `${truth.image?.platform?.os}/${truth.image?.platform?.architecture}`;
      const assertions = [exact('reference', true, text.includes(context.fixture.image)), exact('platform', true, text.includes(platform))];
      if (assertions.some((item) => !item.pass)) await evidence(page, reportDirectory, 'frontend-image');
      return { actual: { apiImageId: truth.image?.imageId, visibleReference: text.includes(context.fixture.image), visiblePlatform: text.includes(platform) }, assertions };
    });

    await context.recorder.run('derived-inventory', '前端沙箱', { projectId: context.projectId }, { fixtureSandboxVisible: true, limitationDisclosed: true }, async () => {
      const sandboxPage = await context.clients.sandbox.listSandboxes(new ListSandboxesRequest({ limit: 100 }));
      const owned = sandboxPage.sandboxes.find(sandbox => context.ledger.sandboxes.has(sandbox.sandboxId) && sandbox.tags.some(tag => tag.name === 'agent' && tag.value === 'deterministic-agent'));
      const sandboxId = owned?.sandboxId ?? '';
      await page.goto(`${base}/#/project/${context.projectId}/agent/deterministic-agent/sandboxes`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForFunction(() => !document.body.innerText.includes('加载中...'), undefined, { timeout: 30_000 });
      const text = await page.locator('body').innerText();
      const shortId = sandboxId.slice(0, 12);
      const visible = Boolean(sandboxId) && (text.includes(sandboxId) || text.includes(shortId));
      const disclosed = /运行|有限|v2|沙箱/.test(text);
      const assertions = [exact('fixtureSandboxVisible', true, visible), predicate('limitationDisclosed', 'page explains derived inventory', disclosed, disclosed)];
      if (assertions.some((item) => !item.pass)) await evidence(page, reportDirectory, 'frontend-sandbox');
      return { actual: { sandboxId, visible, limitationDisclosed: disclosed }, assertions };
    });

    await context.recorder.run('settings-surface', '前端能力边界', { url: '#/settings' }, { settingsVisible: true, capabilityStatusVisible: true }, async () => {
      const text = await pageText(page, `${base}/#/settings`);
      const settingsVisible = text.includes('系统设置') && text.includes('全局环境变量');
      const capabilityStatusVisible = text.includes('Daemon 状态') && text.includes('能力目录');
      if (!settingsVisible || !capabilityStatusVisible) await evidence(page, reportDirectory, 'frontend-settings');
      return { actual: { settingsVisible, capabilityStatusVisible, excerpt: text.slice(0, 500) }, assertions: [exact('settingsVisible', true, settingsVisible), exact('capabilityStatusVisible', true, capabilityStatusVisible)] };
    });

    await context.recorder.run('project-api-truth', '前端项目数据', { projectId: context.projectId }, { projectName: context.fixture.projectName, agentCount: 2 }, async () => {
      const truth = await context.clients.project.getProject(new GetProjectRequest({ project: new ProjectRef({ projectId: context.projectId }), includeSpec: true }));
      const text = await pageText(page, `${base}/#/project/${context.projectId}/agents`);
      return { actual: { apiName: truth.project?.summary?.name, apiAgentCount: truth.project?.summary?.agentCount, visibleName: text.includes(truth.project?.summary?.name ?? ''), visibleAgents: truth.project?.spec?.agents.filter((agent) => text.includes(agent.name)).length }, assertions: [exact('projectName', true, text.includes(context.fixture.projectName)), exact('agentCount', truth.project?.summary?.agentCount, truth.project?.spec?.agents.filter((agent) => text.includes(agent.name)).length)] };
    });

    await context.recorder.run('delete-and-verify', '前端操作', { projectId: context.projectId, action: 'delete through sidebar' }, { confirmationShown: true, removedFromApi: true }, async () => {
      await page.goto(`${base}/#/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const filter = page.getByLabel('筛选智能体应用');
      await filter.fill(context.fixture.projectName);
      const deleteButton = page.getByLabel(`删除智能体应用 ${context.fixture.projectName}`);
      await deleteButton.locator('xpath=..').hover();
      await deleteButton.waitFor({ state: 'visible', timeout: 30_000 });
      let confirmationShown = false;
      page.once('dialog', async (dialog) => { confirmationShown = true; await dialog.accept(); });
      await deleteButton.click();
      let list = await context.clients.project.listProjects({ query: context.fixture.projectName, includeRemoved: false, limit: 10 });
      for (let attempt = 0; attempt < 50 && list.projects.some((project) => project.projectId === context.projectId); attempt++) {
        await page.waitForTimeout(100);
        list = await context.clients.project.listProjects({ query: context.fixture.projectName, includeRemoved: false, limit: 10 });
      }
      const removed = !list.projects.some((project) => project.projectId === context.projectId);
      if (!confirmationShown || !removed) await evidence(page, reportDirectory, 'frontend-delete');
      return { actual: { confirmationShown, removedFromApi: removed, remainingMatches: list.projects.map((project) => project.projectId) }, assertions: [exact('confirmationShown', true, confirmationShown), exact('removedFromApi', true, removed)] };
    });
  } finally {
    await browser.close();
  }
}
