import { expect, test, type Page } from '@playwright/test';
import {
  GetProjectResponse,
  ListRunsRequest,
  OctoBusServerSpec,
  RunStatus,
} from '../../src/gen/agentcompose/v2/agentcompose_pb.js';

const e2ePassword = process.env.AGENT_COMPOSE_E2E_PASSWORD || 'change-me';
const webhookAccessToken = process.env.AGENT_COMPOSE_E2E_WEBHOOK_TOKEN || 'e2e-webhook-token';
const retainedRunId = process.env.AGENT_COMPOSE_E2E_RUN_ID || '';
const retainedFollowupRunId = process.env.AGENT_COMPOSE_E2E_FOLLOWUP_RUN_ID || '';
const retainedSandboxId = process.env.AGENT_COMPOSE_E2E_SANDBOX_ID || '';
const retainedLiveWebhookEventId = process.env.AGENT_COMPOSE_E2E_WEBHOOK_EVENT_ID || '';
const retainedLinkedWebhookEventId = process.env.AGENT_COMPOSE_E2E_LINKED_WEBHOOK_EVENT_ID || '';
const retainedProjectId = process.env.AGENT_COMPOSE_E2E_PROJECT_ID || '';
const retainedAgentName = process.env.AGENT_COMPOSE_E2E_AGENT_NAME || '';
const e2eModel = process.env.AGENT_COMPOSE_E2E_MODEL || 'gpt-5';
const e2eGuestImage = process.env.AGENT_COMPOSE_E2E_GUEST_IMAGE || 'ghcr.io/chaitin/agent-compose-guest:latest';
const e2eMCPURL = process.env.AGENT_COMPOSE_E2E_MCP_URL || 'http://octobus.example/capsets/e2e/mcp';
const webhookAutomationScript = `scheduler.on('ui.acceptance.manual', 'ui-agent-shell', function runShellRegression() {
  return scheduler.agent(
    "Use the shell tool to run: printf 'AUTOMATION_AGENT_SHELL_OK'. After it succeeds, reply with exactly AUTOMATION_AGENT_SHELL_OK."
  );
});

scheduler.on('webhook.ui-regression.acceptance', 'ui-webhook-event', function handleWebhook(event) {
  const body = event && event.payload && event.payload.body;
  return {
    ok: true,
    marker: body ? body.message : '',
    eventId: event && event.payload ? event.payload.eventId : ''
  };
});`;
const webhookAgentConversationScript = `scheduler.on('ui.acceptance.manual', 'ui-agent-shell', function runShellRegression() {
  return scheduler.agent(
    "Use the shell tool to run: printf 'AUTOMATION_AGENT_SHELL_OK'. After it succeeds, reply with exactly AUTOMATION_AGENT_SHELL_OK."
  );
});

scheduler.on('webhook.ui-regression.acceptance', 'ui-webhook-agent-conversation', function handleWebhook() {
  return scheduler.agent('Reply with exactly WEBHOOK_AGENT_CONVERSATION_OK and nothing else.');
});`;

const routes = [
  '/',
  '/agents',
  '/automations',
  '/runs',
  '/conversations',
  '/events',
  '/settings',
  '/images',
  '/capabilities',
  '/mcp',
  '/skills',
  '/settings/caches',
  '/audit',
];

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill(e2ePassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

async function assertPageLayout(page: Page, route: string): Promise<void> {
  await page.evaluate((path) => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
  await expect(page).toHaveURL(new RegExp(`${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  await expect(page.locator('main[data-scroll-root]'), `scroll root is missing on ${route}`).toBeVisible();
  await page.waitForTimeout(250);

  const audit = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('main[data-scroll-root]');
    const layout = root?.querySelector<HTMLElement>('[data-page-layout]');
    if (!root)
      return {
        pageOverflow: 0,
        rootOverflow: 0,
        rootVerticalOverflow: 0,
        fixed: false,
        unowned: ['missing scroll root'],
        nestedPanes: [],
        headerVisible: false,
      };
    const unowned = [...root.querySelectorAll<HTMLElement>('*')]
      .filter((element) => {
        if (!element.offsetParent || element.closest('[data-scroll-surface], [data-scroll-pane]')) return false;
        const style = getComputedStyle(element);
        return /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      })
      .map((element) => {
        const name = element.tagName.toLowerCase();
        const identity = element.id
          ? `#${element.id}`
          : element.className
            ? `.${String(element.className).split(' ')[0]}`
            : '';
        return `${name}${identity}`;
      });
    const nestedPanes = [...root.querySelectorAll<HTMLElement>('[data-scroll-pane]')]
      .filter((pane) => pane.offsetParent && pane.parentElement?.closest('[data-scroll-pane]'))
      .map((pane) => pane.tagName.toLowerCase());
    const header = root.querySelector<HTMLElement>('[data-page-header]');
    const headerBounds = header?.getBoundingClientRect();
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rootOverflow: root.scrollWidth - root.clientWidth,
      rootVerticalOverflow: root.scrollHeight - root.clientHeight,
      fixed: ['master-detail', 'workbench', 'editor', 'dashboard'].includes(layout?.dataset.pageLayout ?? ''),
      unowned,
      nestedPanes,
      headerVisible: Boolean(headerBounds && headerBounds.top >= 44 && headerBounds.bottom <= innerHeight),
    };
  });

  expect(audit.pageOverflow, `${route} overflows the browser viewport`).toBeLessThanOrEqual(1);
  expect(audit.rootOverflow, `${route} overflows the content viewport`).toBeLessThanOrEqual(1);
  if (audit.fixed)
    expect(audit.rootVerticalOverflow, `${route} scrolls outside its owned panes`).toBeLessThanOrEqual(1);
  expect(audit.unowned, `${route} has unowned vertical scroll containers`).toEqual([]);
  expect(audit.nestedPanes, `${route} nests one primary scroll pane inside another`).toEqual([]);
  expect(audit.headerVisible, `${route} loses its page header`).toBe(true);
}

async function setMonacoValue(page: Page, value: string): Promise<void> {
  const editor = page.locator('.monaco-editor').last();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((text) => navigator.clipboard.writeText(text), value);
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+v');
}

async function configureWebhookAutomation(page: Page, script: string): Promise<void> {
  await page.getByRole('button', { name: '自动化任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '自动化任务' })).toBeVisible();
  const taskCard = page.locator('article').filter({ hasText: 'UI Agent Shell Regression' });
  await expect(taskCard).toBeVisible();

  const schedulersResponse = await page.request.post('/agentcompose.v2.ProjectService/ListSchedulers', { data: {} });
  const schedulers = (await schedulersResponse.json()) as {
    schedulers: Array<{ projectId: string; agentName: string; displayName: string; triggerCount: number }>;
  };
  const scheduler = schedulers.schedulers.find((item) => item.displayName === 'UI Agent Shell Regression');
  expect(scheduler).toBeTruthy();
  const projectResponse = await page.request.post('/agentcompose.v2.ProjectService/GetProject', {
    data: { project: { projectId: scheduler!.projectId }, includeSpec: true },
  });
  const projectBody = (await projectResponse.json()) as {
    project: { spec: { agents: Array<Record<string, unknown>> } };
  };
  const agents = projectBody.project.spec.agents.map((agent) =>
    agent.name === scheduler!.agentName
      ? {
          ...agent,
          scheduler: {
            ...(agent.scheduler as Record<string, unknown>),
            script,
            triggers: [],
          },
        }
      : agent,
  );
  const applyResponse = await page.request.post('/agentcompose.v2.ProjectService/ApplyProject', {
    data: { spec: { ...projectBody.project.spec, agents } },
  });
  expect(applyResponse.ok(), await applyResponse.text()).toBeTruthy();

  await expect
    .poll(async () => {
      const response = await page.request.post('/agentcompose.v2.ProjectService/ListSchedulers', { data: {} });
      const body = (await response.json()) as { schedulers: typeof schedulers.schedulers };
      return body.schedulers.find((item) => item.displayName === 'UI Agent Shell Regression')?.triggerCount ?? 0;
    })
    .toBe(2);
}

test('authenticates and loads every primary route without browser errors', async ({ page }) => {
  test.setTimeout(60_000);
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'agent-compose' })).toBeVisible();
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('wrong-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText(/用户名或密码错误|invalid/i)).toBeVisible();

  await page.getByLabel('密码').fill(e2ePassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(page.locator('a[href="/volumes"]')).toHaveCount(0);
  browserErrors.length = 0;
  failedResponses.length = 0;

  for (const route of routes) {
    console.log(`checking ${route}`);
    await page.evaluate((path) => {
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, route);
    await expect(page.locator('main[data-scroll-root]'), `${route}\n${browserErrors.join('\n')}`).toBeVisible();
    await expect(page.getByText('无法启动控制台')).toHaveCount(0);
    await page.waitForTimeout(500);
  }

  await navigateInApp(page, '/runs');
  await expect(page.locator('thead th').first()).toHaveText('智能体');

  await page.reload();
  await expect(page.locator('main[data-scroll-root]')).toBeVisible();

  expect(failedResponses, failedResponses.join('\n')).toEqual([]);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('switches between Chinese and English and persists the locale', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '切换语言' }).click();
  await expect(page.getByRole('button', { name: 'Change language' })).toBeVisible();
  await expect(page.getByText('Overview', { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en-US');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Change language' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ac.locale'))).toBe('en-US');
});

test('keeps primary pages within phone and tablet viewports', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  const navigationButton = page.getByRole('button', { name: '打开导航' });
  await expect(navigationButton).toBeVisible();
  await navigationButton.click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await page.getByRole('button', { name: '事件', exact: true }).click();
  await expect(page).toHaveURL(/\/events$/);

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    for (const route of ['/', '/agents', '/automations', '/runs', '/conversations', '/events', '/settings', '/audit']) {
      await navigateInApp(page, route);
      await page.waitForTimeout(100);
      const dimensions = await page.evaluate(() => ({
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
      }));
      expect(dimensions.documentWidth, `${viewport.width}px ${route} document overflow`).toBeLessThanOrEqual(
        dimensions.viewport + 1,
      );
      expect(dimensions.bodyWidth, `${viewport.width}px ${route} body overflow`).toBeLessThanOrEqual(
        dimensions.viewport + 1,
      );
    }
  }
});

test('normalizes Jupyter links to same-origin token-free entry routes', async ({ page }) => {
  await page.goto('/');
  const paths = await page.evaluate(async () => {
    const { jupyterEntryHref } = await import('/src/model/jupyter.ts');
    return [
      jupyterEntryHref({ proxyPath: '/jupyter/sandbox-1/lab' }),
      jupyterEntryHref({ notebookUrl: 'https://daemon.example/jupyter/sandbox-2/lab?token=secret' }),
      jupyterEntryHref({ proxyPath: '/agent-compose/session/sandbox-3/lab/tree/notebook.ipynb' }),
    ];
  });
  expect(paths).toEqual(['/jupyter/sandbox-1', '/jupyter/sandbox-2', '/agent-compose/session/sandbox-3']);
  expect(paths.join('\n')).not.toContain('token');
});

test('loads the code editor only after intent and keeps the transition responsive', async ({ page }) => {
  const editorRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('monaco-editor') || url.includes('editor.api')) editorRequests.push(url);
  });

  await login(page);
  await page.waitForTimeout(500);
  expect(editorRequests, 'the overview should not preload Monaco').toEqual([]);

  await navigateInApp(page, '/automations');
  const createButton = page.getByRole('button', { name: '新建任务' });
  await createButton.hover();
  await page.waitForTimeout(500);

  const startedAt = Date.now();
  await createButton.click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  expect(Date.now() - startedAt, 'the intent-preloaded editor took too long to appear').toBeLessThan(2_500);
  expect(editorRequests.length, 'Monaco was not loaded for the editor').toBeGreaterThan(0);
});

test('uses explicit document, master-detail, and workbench scrolling across desktop sizes', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const layoutRoutes = [
    ...routes,
    `/conversations/${retainedSandboxId}`,
    `/runs/${retainedRunId}`,
    `/events/${retainedLiveWebhookEventId}`,
  ];
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    for (const route of layoutRoutes) {
      console.log(`auditing ${viewport.width}x${viewport.height} ${route}`);
      await assertPageLayout(page, route);
    }
  }
});

test('keeps workbench controls visible while sibling content panes scroll', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1280, height: 720 });

  await navigateInApp(page, '/agents');
  const agentList = page.locator('[data-scroll-pane]').first();
  await agentList.getByRole('button', { name: /LLM Shell Regression Agent/ }).click();
  const agentHeading = page.getByRole('heading', { name: 'LLM Shell Regression Agent' });
  await expect(agentHeading).toBeVisible();
  const headingTop = await agentHeading.evaluate((element) => element.getBoundingClientRect().top);
  await agentList.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  expect(await agentHeading.evaluate((element) => element.getBoundingClientRect().top)).toBe(headingTop);

  await navigateInApp(page, `/events/${retainedLinkedWebhookEventId}`);
  const eventConversation = page.locator('[data-scroll-pane]').first();
  const eventComposer = page.locator('[data-composer]');
  await expect(eventComposer).toBeVisible();
  const composerBottom = await eventComposer.evaluate((element) => element.getBoundingClientRect().bottom);
  await eventConversation.evaluate((element) => element.scrollTo(0, 0));
  expect(await eventComposer.evaluate((element) => element.getBoundingClientRect().bottom)).toBe(composerBottom);
  expect(composerBottom).toBeLessThanOrEqual(720);
  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible();
  await page.getByRole('button', { name: '回到最新' }).click();
  await expect
    .poll(() =>
      eventConversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThanOrEqual(1);

  await navigateInApp(page, `/runs/${retainedFollowupRunId}`);
  for (const tab of ['对话', '执行动态', '原始日志', '终端', '沙箱']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
    expect(
      await page.locator('main[data-scroll-root]').evaluate((element) => element.scrollHeight - element.clientHeight),
      `${tab} makes the Run workbench page scroll`,
    ).toBeLessThanOrEqual(1);
  }

  await navigateInApp(page, '/settings');
  for (const tab of ['全局环境', '能力网关', 'Webhook', 'Workspace 预设', '鉴权']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
    expect(
      await page.locator('main[data-scroll-root]').evaluate((element) => element.scrollHeight - element.clientHeight),
      `${tab} makes the Settings workbench page scroll`,
    ).toBeLessThanOrEqual(1);
  }
});

test('supports theme, density, command palette, and browser navigation', async ({ page }) => {
  await login(page);

  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder('跳转页面，或输入 ID 直达资源…')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByLabel('切换主题').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByLabel('切换密度').click();
  await page
    .getByRole('button', { name: /智能体/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/agents/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test('distinguishes semantic statuses and the selected tab', async ({ page }) => {
  await login(page);
  await navigateInApp(page, '/runs');
  const failedStatus = page.locator('table [data-semantic-status="failed"]').first();
  await expect(failedStatus).toBeVisible();
  const failedColor = await failedStatus.evaluate((element) => getComputedStyle(element).color);

  await navigateInApp(page, `/events/${retainedLiveWebhookEventId}`);
  const successStatus = page.locator('[data-semantic-status="success"]:visible').first();
  await expect(successStatus).toBeVisible();
  const successColor = await successStatus.evaluate((element) => getComputedStyle(element).color);
  expect(failedColor).not.toBe(successColor);

  await navigateInApp(page, `/conversations/${retainedSandboxId}`);
  const stoppedStatusIcon = page.locator('[data-semantic-status="stopped"] svg').first();
  await expect(stoppedStatusIcon).toBeVisible();
  expect(await stoppedStatusIcon.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');

  await navigateInApp(page, `/runs/${retainedRunId}`);
  const activeTab = page.getByRole('tab', { name: '对话', exact: true });
  const inactiveTab = page.getByRole('tab', { name: '执行动态', exact: true });
  const tabStyles = await Promise.all(
    [activeTab, inactiveTab].map((locator) =>
      locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.backgroundColor}:${style.color}`;
      }),
    ),
  );
  expect(tabStyles[0]).not.toBe(tabStyles[1]);
  await inactiveTab.click();
  await expect(inactiveTab).toHaveAttribute('data-state', 'active');
});

test('keeps document actions sticky and restores document scroll on browser history', async ({ page }) => {
  await login(page);
  await navigateInApp(page, '/runs');
  const root = page.locator('main[data-scroll-root]');
  const header = page.locator('[data-page-header]');
  await expect(page.getByRole('heading', { name: '运行', exact: true })).toBeVisible();
  await expect.poll(() => page.getByRole('row').count()).toBeGreaterThan(1);
  await page.addStyleTag({
    content: 'main[data-scroll-root]::after { content: ""; display: block; height: 48rem; }',
  });
  const headerTop = await header.evaluate((element) => element.getBoundingClientRect().top);
  await root.evaluate((element) => element.scrollTo(0, 480));
  await expect.poll(() => root.evaluate((element) => element.scrollTop)).toBeGreaterThan(400);
  expect(await header.evaluate((element) => element.getBoundingClientRect().top)).toBe(headerTop);

  await page.getByRole('row').nth(1).evaluate((element) => (element as HTMLElement).click());
  await expect(page).toHaveURL(/\/runs\/[a-f0-9]+$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/runs$/);
  await expect
    .poll(() =>
      root.evaluate((element) => {
        const available = element.scrollHeight - element.clientHeight;
        return Math.abs(element.scrollTop - Math.min(480, available));
      }),
    )
    .toBeLessThanOrEqual(1);
});

test('opens the live webhook event from the authenticated event center', async ({ page }) => {
  await page.goto(`/events/${retainedLiveWebhookEventId}`);
  await expect(page.getByRole('heading', { name: 'agent-compose' })).toBeVisible();
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill(e2ePassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/events/${retainedLiveWebhookEventId}$`));
  await expect(page.getByRole('heading', { name: '事件运行结果' })).toBeVisible();

  await navigateInApp(page, '/events?topic=webhook.ui-regression.acceptance');
  await expect(page.getByRole('button', { name: /webhook\.ui-regression\.acceptance/ })).toBeVisible();
  await expect(page.getByText(retainedLiveWebhookEventId, { exact: true })).toBeVisible();
  await page.getByText(retainedLiveWebhookEventId, { exact: true }).click();
  await expect(page.getByRole('heading', { name: '事件运行结果' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '关联对话' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '历史任务' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '事件时间线' })).toBeVisible();
  await expect(page.getByText('agent-compose-ui:live-acceptance-v2', { exact: true })).toBeVisible();
  await expect(page.getByText('Webhook Payload')).toHaveCount(0);
  await expect(page.getByText(/WEBHOOK_LIVE_ACCEPTANCE_OK/)).toHaveCount(0);
  await expect(page.getByText('no_subscriber', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/events/${retainedLiveWebhookEventId}$`));
  await expect(page.getByRole('heading', { name: '事件运行结果' })).toBeVisible();
  await expect(page.getByRole('button', { name: '复制链接' })).toBeVisible();
});

test('copies full resource identifiers and deep links without navigating rows', async ({ page }) => {
  await login(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await navigateInApp(page, '/runs');
  const runCopy = page.getByRole('button', { name: '复制 Run ID' }).first();
  const fullRunId = await runCopy.locator('..').locator('span[title]').getAttribute('title');
  expect(fullRunId).toBeTruthy();
  await runCopy.click();
  await expect(page.getByRole('status').filter({ hasText: '已复制' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fullRunId);
  await expect(page).toHaveURL(/\/runs$/);

  await navigateInApp(page, `/runs/${retainedRunId}`);
  await page.locator('[data-page-header]').getByRole('button', { name: '复制 Run ID' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(retainedRunId);
  await page.getByRole('button', { name: '复制链接' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  await page.getByRole('tab', { name: '终端' }).click();
  await expect(page.getByRole('button', { name: '复制 Sandbox ID' })).toBeVisible();

  await navigateInApp(page, `/events/${retainedLinkedWebhookEventId}`);
  await page.getByRole('button', { name: '复制 Event ID' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(retainedLinkedWebhookEventId);
  await page.getByRole('button', { name: '复制链接' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  await expect(page.getByRole('button', { name: '复制 Scheduler Run ID' }).first()).toBeVisible();

  const detailTime = page.locator('time[datetime]').first();
  await expect(detailTime).toHaveAttribute('datetime', /T/);
  await expect(detailTime).toHaveAttribute('title', /Asia\/Shanghai/);

  await navigateInApp(page, '/runs');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
    });
    document.execCommand = (command) => {
      if (command !== 'copy') return false;
      const active = document.activeElement;
      (window as Window & { __fallbackClipboardValue?: string }).__fallbackClipboardValue =
        active instanceof HTMLTextAreaElement ? active.value : '';
      return true;
    };
  });
  const fallbackCopy = page.getByRole('button', { name: '复制 Run ID' }).first();
  const fallbackRunId = await fallbackCopy.locator('..').locator('span[title]').getAttribute('title');
  await fallbackCopy.click();
  await expect(page.getByRole('status').filter({ hasText: '已复制' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __fallbackClipboardValue?: string }).__fallbackClipboardValue),
    )
    .toBe(fallbackRunId);
});

test('dispatches a webhook event to a real automation trigger', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  await configureWebhookAutomation(page, webhookAutomationScript);

  const response = await page.request.post('/api/webhooks/webhook.ui-regression.acceptance', {
    headers: {
      Authorization: `Bearer ${webhookAccessToken}`,
      'Idempotency-Key': `agent-compose-ui-live-acceptance-${Date.now()}`,
      'X-Correlation-ID': 'agent-compose-ui:live-acceptance-subscribed',
    },
    data: { intent: 'automation-dispatch', message: 'WEBHOOK_AUTOMATION_TRIGGER_OK' },
  });
  expect(response.status()).toBe(202);
  const accepted = (await response.json()) as { event_id: string };

  await expect
    .poll(
      async () => {
        const runsResponse = await page.request.get(`/api/events/${accepted.event_id}/runs`);
        const body = (await runsResponse.json()) as { runs?: Array<{ status: string }> };
        return body.runs?.[0]?.status ?? '';
      },
      { timeout: 30_000 },
    )
    .toMatch(/succeeded|success/i);

  await navigateInApp(page, `/events/${accepted.event_id}`);
  await expect(page.getByRole('heading', { name: '事件运行结果' })).toBeVisible();
  await expect(page.getByText('Webhook Payload')).toHaveCount(0);
  await expect(page.getByText(/WEBHOOK_AUTOMATION_TRIGGER_OK/)).toHaveCount(0);
  await expect(page.getByText('运行成功', { exact: true })).toBeVisible();
  await expect(page.getByText('ui-webhook-event', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '查看调度运行' }).click();
  await expect(page.getByRole('heading', { name: '调度运行详情' })).toBeVisible();
  await expect(page.getByText('run_succeeded')).toHaveCount(0);
  await expect(page.getByText(/不展示调度 payload/)).toBeVisible();
});

test('dispatches a webhook into a linked agent conversation', async ({ page }) => {
  const resumedEventId = process.env.AGENT_COMPOSE_E2E_RESUME_WEBHOOK_EVENT_ID;
  test.skip(
    process.env.AGENT_COMPOSE_E2E_WEBHOOK_AGENT !== '1' && !resumedEventId,
    'requires explicit webhook Agent LLM authorization',
  );
  test.setTimeout(240_000);
  await login(page);
  let accepted = { event_id: resumedEventId ?? '' };
  if (!resumedEventId) {
    await configureWebhookAutomation(page, webhookAgentConversationScript);
    const response = await page.request.post('/api/webhooks/webhook.ui-regression.acceptance', {
      headers: {
        Authorization: `Bearer ${webhookAccessToken}`,
        'Idempotency-Key': `agent-compose-ui-webhook-agent-${Date.now()}`,
        'X-Correlation-ID': 'agent-compose-ui:webhook-agent-conversation',
      },
      data: { intent: 'linked-agent-conversation' },
    });
    expect(response.status()).toBe(202);
    accepted = (await response.json()) as { event_id: string };
  }

  await expect
    .poll(
      async () => {
        const runsResponse = await page.request.get(`/api/events/${accepted.event_id}/runs`);
        const body = (await runsResponse.json()) as { runs?: Array<{ status: string }> };
        return body.runs?.[0]?.status ?? '';
      },
      { timeout: 180_000 },
    )
    .toMatch(/succeeded|success/i);

  await expect
    .poll(
      async () => {
        const sessionsResponse = await page.request.get(`/api/events/${accepted.event_id}/sessions`);
        const body = (await sessionsResponse.json()) as { sessions?: unknown[]; sandboxes?: unknown[] };
        return (body.sessions ?? body.sandboxes ?? []).length;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  await navigateInApp(page, `/events/${accepted.event_id}`);
  await expect(page.getByRole('heading', { name: '事件运行结果' })).toBeVisible();
  await expect(
    page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '关联对话' }) })
      .getByText('WEBHOOK_AGENT_CONVERSATION_OK', { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('ui-webhook-agent-conversation', { exact: true })).toBeVisible();
  await expect(page.getByText('请求正文已隐藏。')).toBeVisible();
  await page.getByRole('button', { name: '关联运行' }).first().click();
  await expect(page).toHaveURL(/\/runs\?sandboxId=/);
  await expect(page.getByRole('heading', { name: '运行' })).toBeVisible();
  await expect(page.getByText('llm-shell-regression-agent', { exact: true }).first()).toBeVisible();
});

test('shows retained run diagnostics and an interactive sandbox terminal', async ({ page }) => {
  test.setTimeout(60_000);
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await login(page);
  browserErrors.length = 0;
  failedResponses.length = 0;
  await navigateInApp(page, `/runs/${retainedRunId}`);

  await expect(page.locator('[data-page-header]').getByText('7625fcb06e3c', { exact: true })).toBeVisible();
  await expect(page.locator('[data-page-header]').getByText('失败', { exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: '对话' }).getByText('Reply with OK only.')).toBeVisible();
  await expect(page.getByRole('tab', { name: '执行动态' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '原始日志' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '沙箱' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '产物' })).toHaveCount(0);

  await page.getByRole('tab', { name: '执行动态' }).click();
  await expect(page.getByText('没有语义事件')).toHaveCount(0);
  await expect(page.getByText('用户消息', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '原始日志' }).click();
  await expect(page.getByRole('button', { name: '下载原始日志' })).toBeVisible();
  await expect(
    page
      .getByRole('tabpanel', { name: '原始日志' })
      .locator('pre')
      .filter({ hasText: /kimi-k2\.6|503|无可用渠道/ }),
  ).toBeVisible();
  await page.getByRole('tab', { name: '沙箱' }).click();
  await expect(page.getByRole('tabpanel', { name: '沙箱' }).getByText('Driver', { exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: '沙箱' }).getByText('Cells / Events')).toBeVisible();

  const terminalRun = await page.evaluate(
    async ({ projectId, agentName }) => {
      const { runClient } = await import('/src/api/client.ts');
      let runId = '';
      let sandboxId = '';
      for await (const event of runClient.runAgentStream({
        projectId,
        agentName,
        source: 1,
        cleanupPolicy: 2,
        command: "printf 'UI_TERMINAL_SANDBOX_READY\\n'",
      })) {
        runId = event.runId || runId;
        sandboxId = event.run?.sandboxId || sandboxId;
      }
      return { runId, sandboxId };
    },
    { projectId: retainedProjectId, agentName: retainedAgentName },
  );
  expect(terminalRun.runId).toBeTruthy();
  expect(terminalRun.sandboxId).toBeTruthy();
  await navigateInApp(page, `/runs/${terminalRun.runId}/terminal`);
  await expect(page.getByText('已连接', { exact: true })).toBeVisible({ timeout: 5_000 });
  const initialTerminalFontSize = await page
    .locator('.xterm-rows > div')
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(initialTerminalFontSize).toBeGreaterThanOrEqual(15);
  await page.getByRole('button', { name: '增大终端字体' }).click();
  await expect
    .poll(() =>
      page
        .locator('.xterm-rows > div')
        .first()
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    )
    .toBeGreaterThan(initialTerminalFontSize);
  const inlineTerminalSize = await page
    .locator('[data-terminal-panel]')
    .evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));
  await page.getByRole('button', { name: '展开终端' }).click();
  const expandedTerminalSize = await page
    .locator('[data-terminal-panel]')
    .evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));
  expect(expandedTerminalSize.width).toBeGreaterThan(inlineTerminalSize.width);
  expect(expandedTerminalSize.height).toBeGreaterThan(inlineTerminalSize.height);
  expect(expandedTerminalSize.height).toBeGreaterThan((await page.evaluate(() => innerHeight)) * 0.9);
  await page.getByRole('button', { name: '还原终端' }).click();
  const terminalInput = page.getByRole('textbox', { name: 'Terminal input' });
  await terminalInput.pressSequentially('echo UI_PTY_OK');
  await terminalInput.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('UI_PTY_OK');
  await terminalInput.pressSequentially('sleep 10');
  await terminalInput.press('Enter');
  await page.getByRole('button', { name: 'Ctrl-C' }).click();
  await terminalInput.pressSequentially('echo UI_INTERRUPT_OK');
  await terminalInput.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('UI_INTERRUPT_OK');

  await expect(page.getByRole('button', { name: '快速命令' })).toHaveCount(0);

  await page.evaluate((path) => {
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/runs/${retainedFollowupRunId}`);
  await expect(
    page.locator('[data-page-header]').getByText(retainedFollowupRunId.slice(0, 12), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('tabpanel', { name: '对话' }).getByText('LLM_FOLLOWUP_OK', { exact: true }),
  ).toBeVisible();
  await page.evaluate(async (sandboxId) => {
    const { sandboxClient } = await import('/src/api/client.ts');
    await sandboxClient.removeSandbox({ sandboxId, force: true });
  }, terminalRun.sandboxId);

  expect(failedResponses, failedResponses.join('\n')).toEqual([]);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('streams RunAgentStream output through the UI proxy before completion', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  const events = await page.evaluate(
    async ({ projectId, agentName }) => {
      const { runClient } = await import('/src/api/client.ts');
      const startedAt = performance.now();
      const observed: Array<{ type: number; chunk: string; elapsedMs: number }> = [];
      for await (const event of runClient.runAgentStream({
        projectId,
        agentName,
        source: 1,
        cleanupPolicy: 3,
        command:
          "printf 'RUN_AGENT_STREAM_1\\n'; sleep 1; printf 'RUN_AGENT_STREAM_2\\n'; sleep 1; printf 'RUN_AGENT_STREAM_3\\n'",
      })) {
        observed.push({ type: event.eventType, chunk: event.chunk, elapsedMs: performance.now() - startedAt });
      }
      return observed;
    },
    {
      projectId: retainedProjectId,
      agentName: 'llm-shell-regression-agent',
    },
  );

  const outputEvents = events.filter((event) => event.type === 2);
  const completed = events.find((event) => event.type === 4);
  expect(events[0]?.type).toBe(1);
  expect(outputEvents.map((event) => event.chunk).join('')).toContain(
    'RUN_AGENT_STREAM_1\nRUN_AGENT_STREAM_2\nRUN_AGENT_STREAM_3',
  );
  expect(outputEvents.length).toBeGreaterThanOrEqual(3);
  expect(completed).toBeTruthy();
  expect(completed!.elapsedMs - outputEvents[0].elapsedMs).toBeGreaterThan(1_500);
});

test('keeps a deterministic RunAgentStream visible across navigation', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);

  await page.evaluate(
    async ({ projectId, agentName }) => {
      const { runStreams } = await import('/src/lib/run-stream.svelte.ts');
      const testWindow = window as Window & {
        __streamRunId?: string;
        __streamSandboxId?: string;
        __streamError?: string;
      };
      void runStreams
        .start(
          {
            projectId,
            agentName,
            displayPrompt: 'Deterministic UI stream regression',
            command:
              "printf 'UI_STREAM_CHUNK_1\\n'; sleep 3; printf 'UI_STREAM_CHUNK_2\\n'; sleep 3; printf 'UI_STREAM_CHUNK_3\\n'",
          },
          (stream) => {
            testWindow.__streamRunId = stream.runId;
            testWindow.__streamSandboxId = stream.sandboxId;
          },
        )
        .then((stream) => {
          if (stream.phase === 'failed') testWindow.__streamError = stream.error;
        });
    },
    { projectId: retainedProjectId, agentName: retainedAgentName },
  );

  await expect
    .poll(() =>
      page.evaluate(() => {
        const testWindow = window as Window & { __streamRunId?: string; __streamError?: string };
        return testWindow.__streamRunId || testWindow.__streamError || '';
      }),
    )
    .not.toBe('');
  const streamResult = await page.evaluate(() => {
    const testWindow = window as Window & { __streamRunId?: string; __streamError?: string };
    return { runId: testWindow.__streamRunId || '', error: testWindow.__streamError || '' };
  });
  expect(streamResult.error).toBe('');
  const runId = streamResult.runId;
  await page.evaluate((targetRunId) => {
    history.pushState({}, '', `/runs/${targetRunId}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, runId);

  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
  await expect
    .poll(() =>
      page.evaluate(async (targetRunId) => {
        const { runStreams } = await import('/src/lib/run-stream.svelte.ts');
        const stream = runStreams.forRun(targetRunId);
        return stream ? `${stream.phase}:${stream.output}` : 'missing';
      }, runId),
    )
    .toContain('UI_STREAM_CHUNK_1');
  const liveStream = page.locator('[aria-live="polite"]').filter({ hasText: 'Deterministic UI stream regression' });
  await expect(liveStream.getByText('UI_STREAM_CHUNK_1', { exact: false })).toBeVisible();
  await expect(liveStream.getByText('UI_STREAM_CHUNK_3', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '回复中…' })).toBeVisible();
  await expect(liveStream.getByText('UI_STREAM_CHUNK_2', { exact: false })).toBeVisible({ timeout: 6_000 });
  await expect(page.getByText('UI_STREAM_CHUNK_3', { exact: false }).first()).toBeVisible({ timeout: 6_000 });
  const streamSandboxId = await page.evaluate((targetRunId) => {
    const testWindow = window as Window & { __streamRunId?: string; __streamSandboxId?: string };
    return testWindow.__streamRunId === targetRunId ? testWindow.__streamSandboxId || '' : '';
  }, runId);
  expect(streamSandboxId).toBeTruthy();
  await page.evaluate(async (sandboxId) => {
    const { sandboxClient } = await import('/src/api/client.ts');
    await sandboxClient.removeSandbox({ sandboxId, force: true });
  }, streamSandboxId);
});

test('groups retained runs into a frontend conversation history', async ({ page }) => {
  await login(page);
  await navigateInApp(page, `/conversations/${retainedSandboxId}`);
  await expect(page.getByRole('heading', { name: '对话记录' })).toBeVisible();
  await expect(page.getByRole('button', { name: '复制 Sandbox ID' })).toBeVisible();
  await expect(page.getByText('WEBHOOK_AGENT_CONVERSATION_OK', { exact: true })).toBeVisible();

  await page.getByPlaceholder('搜索当前对话').fill('WEBHOOK_AGENT_CONVERSATION_OK');
  await expect(page.getByRole('tabpanel', { name: '对话' }).locator('article')).toHaveCount(1);
  await page.getByPlaceholder('搜索当前对话').fill('');

  await page.getByRole('tab', { name: '执行记录' }).click();
  await expect(
    page.getByRole('tabpanel', { name: '执行记录' }).getByRole('button', { name: '复制 Run ID' }).first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '查看运行详情' }).first()).toBeVisible();
  await page.getByRole('tab', { name: '执行动态' }).click();
  await expect(page.getByRole('tabpanel', { name: '执行动态' })).toBeVisible();
});

test('shows conversation send feedback before a stream request finishes', async ({ page }) => {
  test.setTimeout(60_000);
  const prompt = `UI_PENDING_MESSAGE_${Date.now()}`;
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
  });
  await login(page);
  const target = await page.evaluate(
    async ({ projectId, agentName }) => {
      const { runClient } = await import('/src/api/client.ts');
      let runId = '';
      let sandboxId = '';
      for await (const event of runClient.runAgentStream({
        projectId,
        agentName,
        source: 1,
        cleanupPolicy: 2,
        command: "printf 'UI_PENDING_SANDBOX_READY\\n'",
      })) {
        runId = event.runId || runId;
        sandboxId = event.run?.sandboxId || sandboxId;
      }
      return { runId, sandboxId };
    },
    { projectId: retainedProjectId, agentName: retainedAgentName },
  );
  expect(target.runId).toBeTruthy();
  expect(target.sandboxId).toBeTruthy();

  try {
    await page.route('**/agentcompose.v2.RunService/RunAgentStream', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.abort('failed');
    });
    await navigateInApp(page, `/runs/${target.runId}`);
    const composer = page.locator('[data-composer]');
    await composer.getByPlaceholder('输入消息').fill(prompt);
    await composer.getByRole('button', { name: '发送', exact: true }).click();

    const pending = page.locator('[aria-live="polite"]').filter({ hasText: prompt });
    await expect(pending).toBeVisible();
    await expect(pending).toContainText('正在发送…');
    await expect(composer.getByRole('button', { name: '回复中…' })).toBeDisabled();
    const failedTurn = page.locator('[data-conversation-turn][data-status="failed"]').filter({ hasText: prompt });
    await expect(failedTurn).toBeVisible({ timeout: 5_000 });
    await expect(failedTurn).toContainText(/失败|fetch|网络|请求/i);
    await expect(page.locator('[data-page-error]')).toHaveCount(0);
  } finally {
    await page.unroute('**/agentcompose.v2.RunService/RunAgentStream');
    await page.evaluate(async (id) => {
      const { sandboxClient } = await import('/src/api/client.ts');
      await sandboxClient.removeSandbox({ sandboxId: id, force: true });
    }, target.sandboxId);
  }
});

test('prioritizes and filters enabled agents and automations', async ({ page }) => {
  await login(page);
  await navigateInApp(page, '/agents');

  const agentFilters = page.getByLabel('智能体状态筛选');
  await expect(agentFilters.getByRole('button', { name: /已启用 \d+/, pressed: true })).toBeVisible();
  const agentRows = page.locator('aside [data-scroll-pane] > button');
  const enabledAgentCount = await agentRows.count();
  for (let index = 0; index < enabledAgentCount; index += 1) {
    await expect(agentRows.nth(index)).toContainText('已启用');
  }
  await page.getByPlaceholder('过滤智能体…').fill('__no_matching_agent__');
  await expect(page.getByText('没有匹配的智能体')).toBeVisible();

  await navigateInApp(page, '/automations');
  const automationFilters = page.getByLabel('自动化任务状态筛选');
  await expect(automationFilters.getByRole('button', { name: /已启用 \d+/, pressed: true })).toBeVisible();
  const automationCards = page.locator('article');
  const enabledTaskCount = await automationCards.count();
  for (let index = 0; index < enabledTaskCount; index += 1) {
    await expect(automationCards.nth(index)).toContainText('已启用');
  }
  await page.getByPlaceholder('搜索任务、智能体或任务 ID').fill('__no_matching_automation__');
  await expect(page.getByText('没有匹配的自动化任务')).toBeVisible();
});

test('bounds overview run requests without loading project definitions', async ({ page }) => {
  const requests: Array<{ url: string; body?: { limit: number; status: RunStatus } }> = [];
  page.on('request', (request) => {
    if (!request.url().includes('/agentcompose.v2.')) return;
    const framedBody = request.postDataBuffer();
    let body: { limit: number; status: RunStatus } | undefined;
    if (request.url().endsWith('.RunService/ListRuns') && framedBody && framedBody.length >= 5) {
      const message = ListRunsRequest.fromBinary(framedBody.subarray(5));
      body = { limit: message.limit, status: message.status };
    }
    requests.push({ url: request.url(), body });
  });

  await login(page);
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  await expect.poll(() => requests.filter((item) => item.url.endsWith('.RunService/ListRuns')).length).toBe(2);

  const runBodies = requests.filter((item) => item.url.endsWith('.RunService/ListRuns')).map((item) => item.body!);
  expect(runBodies.map((body) => body.limit).sort((left, right) => Number(left) - Number(right))).toEqual([6, 12]);
  expect(runBodies.some((body) => body.status === RunStatus.RUNNING)).toBe(true);
  expect(
    requests.filter(
      (item) => item.url.includes('.ProjectService/ListProjects') || item.url.includes('.ProjectService/GetProject'),
    ),
  ).toEqual([]);
});

test('manages API tokens through the redesigned settings page', async ({ page }) => {
  await login(page);
  await navigateInApp(page, '/settings');
  await page.getByRole('tab', { name: 'API Token' }).click();
  await expect(page.getByRole('heading', { name: 'API Token', exact: true })).toBeVisible();

  if (await page.getByText('Token 管理功能未启用').isVisible()) return;

  const name = `UI Regression Token ${Date.now()}`;
  await page.getByRole('button', { name: '创建 Token' }).click();
  await page.getByLabel('名称').fill(name);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Token 已创建' })).toBeVisible();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '复制 Token' }).click();
  await expect(page.getByRole('button', { name: '已复制' })).toBeVisible();
  await page.getByRole('button', { name: '完成' }).click();

  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('有效');
  await row.getByRole('button', { name: '撤销' }).click();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(row).toContainText('已撤销');
});

test('attributes write operations to the current user and exports audit events', async ({ page }) => {
  await login(page);
  const name = `Audit Regression ${Date.now()}`;
  const create = await page.request.post('/api/ui/v1/tokens', {
    data: { name, role: 'read-only-admin', expiresInDays: 1 },
  });
  expect(create.status()).toBe(201);
  const created = (await create.json()) as { id: string };
  expect(created.id).toBeTruthy();
  const revoke = await page.request.delete(`/api/ui/v1/tokens/${created.id}`);
  expect(revoke.status()).toBe(204);

  await navigateInApp(page, '/audit');
  await expect(page.getByRole('heading', { name: '审计日志', exact: true })).toBeVisible();
  await page.getByLabel('操作').fill('DELETE /api/ui/v1/tokens/' + created.id);
  await page.getByRole('button', { name: '查询', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: created.id.slice(0, 16) });
  await expect(row).toContainText('admin');
  await expect(row).toContainText('成功');
  await row.click();
  await expect(page.getByRole('heading', { name: '审计详情' })).toBeVisible();
  await expect(page.getByText('local:admin', { exact: true })).toBeVisible();

  for (const format of ['JSON', 'CSV']) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: new RegExp(format) }).click();
    expect((await download).suggestedFilename()).toBe(`audit-events.${format.toLowerCase()}`);
  }
});

test('does not rewrite projects with redacted project OctoBus credentials', async ({ page }) => {
  let applyProjectRequests = 0;

  await page.route('**/agentcompose.v2.ProjectService/GetProject', async (route) => {
    const response = await route.fetch();
    const framed = new Uint8Array(await response.body());
    const messageLength = new DataView(framed.buffer, framed.byteOffset + 1, 4).getUint32(0);
    const body = GetProjectResponse.fromBinary(framed.subarray(5, 5 + messageLength));
    if (body.project?.spec)
      body.project.spec.octobusServers = [
        new OctoBusServerSpec({
          name: 'internal',
          endpoint: 'https://octobus.example',
          token: '********',
        }),
      ];
    const encoded = body.toBinary();
    const rewritten = new Uint8Array(5 + encoded.length + framed.length - 5 - messageLength);
    rewritten[0] = framed[0];
    new DataView(rewritten.buffer, 1, 4).setUint32(0, encoded.length);
    rewritten.set(encoded, 5);
    rewritten.set(framed.subarray(5 + messageLength), 5 + encoded.length);
    await route.fulfill({ response, body: Buffer.from(rewritten) });
  });
  await page.route('**/agentcompose.v2.ProjectService/ApplyProject', async (route) => {
    applyProjectRequests += 1;
    await route.fulfill({ status: 418, body: 'ApplyProject must not be called' });
  });

  await login(page);
  await navigateInApp(page, '/mcp');
  const resource = page.locator('article').filter({ hasText: 'ui-regression-mcp' });
  await expect(resource).toBeVisible();
  await resource.getByRole('button', { name: '编辑' }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();

  await expect(page.getByText(/该项目包含项目级 OctoBus 配置/)).toBeVisible();
  expect(applyProjectRequests).toBe(0);
  await expect(page.getByText('ui-regression-mcp', { exact: true })).toBeVisible();
});

test('persists system, OctoBus, MCP, Skill, and editor configuration', async ({ page }) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await login(page);
  browserErrors.length = 0;
  failedResponses.length = 0;

  await navigateInApp(page, '/settings');
  await page.getByRole('tab', { name: '能力网关' }).click();
  await expect(page.getByText('OctoBus 已连接')).toBeVisible();
  await expect(page.getByText(/1 个服务/)).toBeVisible();
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByText('能力网关状态已刷新')).toBeVisible();

  await page.getByRole('tab', { name: 'Webhook' }).click();
  const webhookPanel = page.getByRole('tabpanel', { name: 'Webhook' });
  const webhookTestToken = webhookAccessToken;
  const webhookCard = webhookPanel
    .locator('div.flex.items-center.justify-between')
    .filter({ hasText: 'UI Regression Webhook' });
  if ((await webhookCard.count()) === 0) {
    await webhookPanel.getByPlaceholder('唯一 ID').fill('ui-regression-webhook');
    await webhookPanel.getByPlaceholder('名称').fill('UI Regression Webhook');
    await webhookPanel.getByPlaceholder('Provider').fill('test');
    await webhookPanel.getByPlaceholder('Topic 前缀').fill('webhook.ui-regression.');
    await webhookPanel.getByPlaceholder('访问 Token（留空保持）').fill(webhookTestToken);
    await webhookPanel.getByRole('button', { name: '添加来源' }).click();
  } else {
    await webhookCard.getByRole('button', { name: '编辑' }).click();
    await webhookPanel.getByPlaceholder('Topic 前缀').fill('webhook.ui-regression.');
    await webhookPanel.getByPlaceholder('访问 Token（留空保持）').fill(webhookTestToken);
    await webhookPanel.getByRole('button', { name: '保存修改' }).click();
  }
  await expect(page.getByText('Webhook 来源已保存')).toBeVisible();

  const webhookResponse = await page.request.post('/api/webhooks/webhook.ui-regression.acceptance', {
    headers: {
      Authorization: `Bearer ${webhookTestToken}`,
      'Idempotency-Key': 'agent-compose-ui-regression-v1',
      'X-Correlation-ID': 'agent-compose-ui:regression',
    },
    data: { intent: 'ui-regression', message: 'WEBHOOK_EVENT_DETAIL_OK' },
  });
  expect(webhookResponse.status()).toBe(202);
  const acceptedWebhook = (await webhookResponse.json()) as { event_id: string };
  expect(acceptedWebhook.event_id).toBeTruthy();
  await navigateInApp(page, '/events?topic=webhook.ui-regression.acceptance');
  await expect(page.getByText(acceptedWebhook.event_id, { exact: true })).toBeVisible();
  await page.getByText(acceptedWebhook.event_id, { exact: true }).click();
  await expect(page.getByRole('heading', { name: '事件运行结果' })).toBeVisible();
  await expect(page.getByText('webhook.ui-regression.acceptance', { exact: true })).toBeVisible();
  await expect(page.getByText(/WEBHOOK_EVENT_DETAIL_OK/)).toHaveCount(0);
  await expect(page.getByText('Webhook Payload')).toHaveCount(0);

  await navigateInApp(page, '/settings');
  await page.getByRole('tab', { name: 'Workspace 预设' }).click();
  const workspacePanel = page.getByRole('tabpanel', { name: 'Workspace 预设' });
  const workspaceCard = workspacePanel.locator('div.flex.items-start.justify-between').filter({
    hasText: 'UI Regression Workspace',
  });
  if ((await workspaceCard.count()) === 0) {
    await workspacePanel.getByPlaceholder('名称').fill('UI Regression Workspace');
  } else {
    await workspaceCard.getByRole('button', { name: '编辑' }).click();
  }
  await workspacePanel.getByPlaceholder('备注').fill('agent-compose-ui acceptance data');
  await setMonacoValue(page, '{"path":"/tmp/ui-regression-workspace"}');
  await page.getByRole('button', { name: '格式化' }).click();
  await page.getByRole('button', { name: '全屏' }).click();
  await expect(page.getByRole('button', { name: '退出全屏' })).toBeVisible();
  await page.getByRole('button', { name: '退出全屏' }).click();
  await page.getByRole('button', { name: /创建|保存修改/ }).click();
  await expect(page.getByText('Workspace 预设已创建')).toBeVisible();

  await navigateInApp(page, '/agents');
  const uiRegressionAgent = page.getByRole('button', { name: /UI Regression Agent/ });
  await expect(uiRegressionAgent)
    .toBeVisible({ timeout: 10_000 })
    .catch(() => undefined);
  if ((await uiRegressionAgent.count()) === 0) {
    await page.getByRole('button', { name: '新建智能体' }).click();
    await page.getByLabel('调用标识').fill('ui-regression-agent');
    await page.getByLabel('显示名称').fill('UI Regression Agent');
    await page.getByLabel('模型').fill(e2eModel);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'UI Regression Agent' })).toBeVisible({ timeout: 30_000 });
  }

  await navigateInApp(page, '/mcp');
  const mcpExists = (await page.getByText('ui-regression-mcp', { exact: true }).count()) > 0;
  if (!mcpExists) {
    await page.getByRole('button', { name: '新增 MCP' }).click();
  } else {
    await page
      .locator('article')
      .filter({ hasText: 'ui-regression-mcp' })
      .getByRole('button', { name: '编辑' })
      .click();
  }
  if (!mcpExists) {
    const target = page.getByLabel('配置目标');
    const value = await target
      .locator('option')
      .filter({ hasText: /ui-agents.*项目级/ })
      .getAttribute('value');
    await target.selectOption(value ?? '');
  }
  await setMonacoValue(
    page,
    JSON.stringify({
      name: 'ui-regression-mcp',
      type: 'remote',
      transport: 'http',
      url: e2eMCPURL,
    }),
  );
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('MCP 配置已保存')).toBeVisible();

  await navigateInApp(page, '/skills');
  const skillExists = (await page.getByText('octobus-service-package', { exact: true }).count()) > 0;
  if (!skillExists) {
    await page.getByRole('button', { name: '新增 Skill' }).click();
  } else {
    await page
      .locator('article')
      .filter({ hasText: 'octobus-service-package' })
      .getByRole('button', { name: '编辑' })
      .click();
  }
  if (!skillExists) {
    const target = page.getByLabel('配置目标');
    const value = await target
      .locator('option')
      .filter({ hasText: /ui-agents.*UI Regression Agent/ })
      .getAttribute('value');
    await target.selectOption(value ?? '');
  }
  await setMonacoValue(
    page,
    JSON.stringify({
      name: 'octobus-service-package',
      provider: 'git',
      url: 'https://github.com/chaitin/OctoBus.git',
      path: 'skills/octobus-service-package',
      ref: 'main',
    }),
  );
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('Skill 配置已保存')).toBeVisible();

  expect(failedResponses, failedResponses.join('\n')).toEqual([]);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('runs a real LLM conversation and an automation agent shell task', async ({ page }) => {
  test.skip(process.env.AGENT_COMPOSE_E2E_REAL_LLM !== '1', 'requires explicit authorization for real LLM calls');
  test.setTimeout(300_000);
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await login(page);
  browserErrors.length = 0;
  failedResponses.length = 0;

  await navigateInApp(page, '/agents');
  const regressionAgentName = 'LLM Shell Regression Agent';
  const regressionAgentButton = page.getByRole('button', { name: new RegExp(regressionAgentName) });
  await expect(regressionAgentButton)
    .toBeVisible({ timeout: 10_000 })
    .catch(() => undefined);
  if ((await regressionAgentButton.count()) === 0) {
    await page.getByRole('button', { name: '新建智能体' }).click();
    await page.getByLabel('调用标识').fill('llm-shell-regression-agent');
    await page.getByLabel('显示名称').fill(regressionAgentName);
    await page.getByLabel('模型').fill(e2eModel);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('heading', { name: regressionAgentName })).toBeVisible({ timeout: 30_000 });
  } else {
    await regressionAgentButton.click();
  }
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('Guest 镜像').fill(e2eGuestImage);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: regressionAgentName })).toBeVisible({ timeout: 30_000 });
  if (process.env.AGENT_COMPOSE_E2E_AUTOMATION_ONLY !== '1') {
    const resumedRunId = process.env.AGENT_COMPOSE_E2E_RESUME_RUN_ID;
    if (resumedRunId) {
      await navigateInApp(page, `/runs/${resumedRunId}`);
    } else {
      const runPrompt = page.getByPlaceholder('输入一次短任务');
      await runPrompt.fill('Reply with exactly LLM_DIALOGUE_OK and nothing else.');
      await runPrompt.locator('..').getByRole('button', { name: '运行', exact: true }).click();
      await expect(page).toHaveURL(/\/runs\//, { timeout: 180_000 });
    }
    const chatPanel = page.getByRole('tabpanel', { name: '对话' });
    await expect(chatPanel.getByText('LLM_DIALOGUE_OK', { exact: true })).toBeVisible({ timeout: 30_000 });

    const previousRunUrl = page.url();
    const followupPrompt = 'Reply with exactly LLM_FOLLOWUP_OK and nothing else.';
    await page.getByPlaceholder('输入消息').fill(followupPrompt);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: followupPrompt })).toContainText(
      /正在发送|回复中/,
    );
    await expect(chatPanel.getByText(/LLM_FOLLOWUP_OK/)).toBeVisible({ timeout: 180_000 });
    await expect(page).toHaveURL(previousRunUrl);
    await expect(chatPanel.getByRole('button', { name: /^查看运行 [a-f0-9]{12}/ })).toBeVisible();
  }

  await page.getByRole('button', { name: '自动化任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '自动化任务' })).toBeVisible();
  const taskName = 'UI Agent Shell Regression';
  const taskCard = page.locator('article').filter({ hasText: taskName });
  if ((await taskCard.count()) === 0) {
    await page.getByRole('button', { name: '新建任务' }).click();
    await page.getByLabel('名称').fill(taskName);
    await page.getByLabel('绑定智能体').selectOption({ label: regressionAgentName });
  } else {
    await taskCard.getByRole('button', { name: '编辑' }).click();
  }
  await page.getByLabel('描述').fill('Acceptance regression: automation invokes an agent that executes shell.');
  await expect(page.getByLabel('Runtime')).toHaveValue('scheduler');
  await setMonacoValue(page, webhookAutomationScript);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(taskCard).toBeVisible({ timeout: 30_000 });
  const resumedAutomationRunId = process.env.AGENT_COMPOSE_E2E_RESUME_AUTOMATION_RUN_ID;
  if (resumedAutomationRunId) {
    await navigateInApp(page, `/runs/${resumedAutomationRunId}`);
  } else {
    await taskCard.getByRole('button', { name: '立即运行' }).click();
    await expect(page).toHaveURL(/\/runs\//, { timeout: 30_000 });
  }
  const agentOutput = page
    .getByRole('tabpanel', { name: '对话' })
    .getByText('智能体输出', { exact: true })
    .locator('..')
    .locator('pre');
  const automationFailure = page.getByRole('tabpanel', { name: '对话' }).locator('p.text-destructive').last();
  await expect(agentOutput.or(automationFailure)).toBeVisible({ timeout: 180_000 });
  if ((await agentOutput.filter({ hasText: 'AUTOMATION_AGENT_SHELL_OK' }).count()) === 0) {
    throw new Error(`automation agent shell failed: ${(await automationFailure.textContent()) || 'missing output'}`);
  }

  expect(failedResponses, failedResponses.join('\n')).toEqual([]);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
