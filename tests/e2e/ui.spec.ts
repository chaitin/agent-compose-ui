import { expect, test, type Page } from '@playwright/test';
import {
  GetProjectResponse,
  ListRunsRequest,
  MCPServerSpec,
  OctoBusServerSpec,
  RunStatus,
} from '../../src/gen/agentcompose/v2/agentcompose_pb.js';
import { HealthStatusResponse, ProcessUsage } from '../../src/gen/health/v1/health_pb.js';

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
const webhookSchedulerDisplayName = 'UI Webhook Regression';
const agentShellAutomationScript = `scheduler.on('ui.acceptance.manual', 'ui-agent-shell', function runShellRegression() {
  return scheduler.agent(
    "Use the shell tool to run: printf 'AUTOMATION_AGENT_SHELL_OK'. After it succeeds, reply with exactly AUTOMATION_AGENT_SHELL_OK."
  );
});`;
const webhookAutomationScript = `${agentShellAutomationScript}

scheduler.on('webhook.ui-regression.acceptance', 'ui-webhook-event', function handleWebhook(event) {
  const body = event && event.payload && event.payload.body;
  return {
    ok: true,
    marker: body ? body.message : '',
    eventId: event && event.payload ? event.payload.eventId : ''
  };
});`;
const webhookAgentConversationScript = `${agentShellAutomationScript}

scheduler.on('webhook.ui-regression.acceptance', 'ui-webhook-agent-conversation', function handleWebhook() {
  return scheduler.agent('Reply with exactly WEBHOOK_AGENT_CONVERSATION_OK and nothing else.');
});`;
const webhookShellContextScript = `${agentShellAutomationScript}

scheduler.on('webhook.ui-regression.acceptance', 'ui-webhook-shell-context', function handleWebhook() {
  return scheduler.shell(
    "printf 'WEBHOOK_SHELL_CONTEXT_1\\n'; sleep 5; printf 'WEBHOOK_SHELL_CONTEXT_2\\n'; sleep 5; printf 'WEBHOOK_SHELL_CONTEXT_3\\n'"
  );
});`;
const webhookMultiConversationScript = `${agentShellAutomationScript}

scheduler.on('webhook.ui-regression.acceptance', 'ui-webhook-multi-conversation', function handleWebhook() {
  const shell = scheduler.shell("printf 'WEBHOOK_MULTI_CONVERSATION_A\\n'", { title: 'Webhook branch A' });
  const agent = scheduler.agent('Reply with exactly WEBHOOK_MULTI_CONVERSATION_B and nothing else.', {
    sandboxPolicy: 'new',
    title: 'Webhook branch B'
  });
  return { shell, agent };
});`;

const routes = [
  '/',
  '/projects',
  '/sandboxes',
  '/runs/unlinked',
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
  await expect.poll(() => page.evaluate(() => location.pathname)).toBe(path.split(/[?#]/, 1)[0]);
}

function grpcWebUnaryBody(message: Uint8Array): Buffer {
  const messageFrame = Buffer.alloc(5 + message.length);
  messageFrame.writeUInt32BE(message.length, 1);
  Buffer.from(message).copy(messageFrame, 5);

  const trailers = Buffer.from('grpc-status: 0\r\n');
  const trailerFrame = Buffer.alloc(5 + trailers.length);
  trailerFrame[0] = 0x80;
  trailerFrame.writeUInt32BE(trailers.length, 1);
  trailers.copy(trailerFrame, 5);
  return Buffer.concat([messageFrame, trailerFrame]);
}

async function assertPageLayout(page: Page, route: string): Promise<void> {
  await page.evaluate((path) => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
  await expect.poll(() => page.evaluate(() => location.pathname)).toBe(route);
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
        frameBounds: [],
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
    const frameBounds = [...root.querySelectorAll<HTMLElement>('[data-page-frame]')]
      .filter((frame) => frame.offsetParent)
      .map((frame) => {
        const bounds = frame.getBoundingClientRect();
        return { left: Math.round(bounds.left), right: Math.round(bounds.right) };
      });
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rootOverflow: root.scrollWidth - root.clientWidth,
      rootVerticalOverflow: root.scrollHeight - root.clientHeight,
      fixed: ['master-detail', 'workbench', 'editor', 'dashboard'].includes(layout?.dataset.pageLayout ?? ''),
      unowned,
      nestedPanes,
      headerVisible: Boolean(headerBounds && headerBounds.top >= 44 && headerBounds.bottom <= innerHeight),
      frameBounds,
    };
  });

  expect(audit.pageOverflow, `${route} overflows the browser viewport`).toBeLessThanOrEqual(1);
  expect(audit.rootOverflow, `${route} overflows the content viewport`).toBeLessThanOrEqual(1);
  if (audit.fixed)
    expect(audit.rootVerticalOverflow, `${route} scrolls outside its owned panes`).toBeLessThanOrEqual(1);
  expect(audit.unowned, `${route} has unowned vertical scroll containers`).toEqual([]);
  expect(audit.nestedPanes, `${route} nests one primary scroll pane inside another`).toEqual([]);
  expect(audit.headerVisible, `${route} loses its page header`).toBe(true);
  expect(audit.frameBounds.length, `${route} has no shared page frame`).toBeGreaterThan(0);
  const leftEdges = audit.frameBounds.map((bounds) => bounds.left);
  const rightEdges = audit.frameBounds.map((bounds) => bounds.right);
  expect(
    Math.max(...leftEdges) - Math.min(...leftEdges),
    `${route} has misaligned left content edges`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.max(...rightEdges) - Math.min(...rightEdges),
    `${route} has misaligned right content edges`,
  ).toBeLessThanOrEqual(1);
}

test('shows a single prefix for an already-prefixed daemon version', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { enabled: false, loggedIn: true, oauthEnabled: false } }),
  );
  await page.route('**/health.v1.HealthService/Status', (route) =>
    route.fulfill({
      contentType: 'application/grpc-web+proto',
      body: grpcWebUnaryBody(
        new HealthStatusResponse({
          version: 'v2608.2.0',
          process: new ProcessUsage({ cpuPercent: 12, rssBytes: BigInt(1048576) }),
        }).toBinary(),
      ),
    }),
  );

  await page.goto('/');
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(page.getByText(/v2608\.2\.0 · CPU 12%/).first()).toBeVisible();
  await expect(page.getByText(/vv2608\.2\.0/)).toHaveCount(0);
});

test('uses OAuth-only login when OAuth is enabled', async ({ page }) => {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { enabled: true, loggedIn: false, oauthEnabled: true } }),
  );
  let authorizeURL = '';
  await page.route('**/oauth/authorize?*', async (route) => {
    authorizeURL = route.request().url();
    await route.fulfill({ contentType: 'text/html', body: 'oauth started' });
  });

  await page.goto('/projects');
  await expect(page.getByLabel('用户名')).toHaveCount(0);
  await expect(page.getByLabel('密码')).toHaveCount(0);
  await page.getByRole('button', { name: '使用 OAuth 登录' }).click();
  await expect.poll(() => authorizeURL).toContain('/oauth/authorize?');
  expect(new URL(authorizeURL).searchParams.get('next')).toBe('/projects');
});

test('keeps projects visible when the capability gateway is unavailable', async ({ page }) => {
  await login(page);
  const response = await page.request.get('/api/ui/v1/projects');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { projects: Array<{ name: string }> };
  expect(body.projects.length).toBeGreaterThan(0);
  await page.route('**/agentcompose.v2.CapabilityService/ListCapabilitySets', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"gateway unavailable"}' }),
  );

  await navigateInApp(page, '/projects');
  await expect(page.getByText(body.projects[0].name, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('能力网关暂时不可用，项目仍可查看，能力集暂不可编辑')).toBeVisible();
  await expect(page.locator('[data-page-error]')).toHaveCount(0);
});

test('loads webhook events newest first with offset pagination', async ({ page }) => {
  await login(page);
  const offsets: number[] = [];
  let topicsRequested = false;
  await page.route('**/api/events/topics?*', async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('source')).toBe('webhook');
    topicsRequested = true;
    await route.fulfill({
      json: {
        items: [{ topic: 'webhook.pagination', event_count: 3, latest_event_at: '2026-07-30T00:00:03Z' }],
        total: 1,
      },
    });
  });
  await page.route('**/api/events?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/events') {
      await route.continue();
      return;
    }
    expect(url.searchParams.get('source')).toBe('webhook');
    expect(url.searchParams.get('view')).toBe('summary');
    const offset = Number(url.searchParams.get('offset') || 0);
    offsets.push(offset);
    const sequences = offset === 0 ? [3, 2] : [1];
    await route.fulfill({
      json: {
        items: sequences.map((sequence) => ({
          event_id: `event-${sequence}`,
          sequence,
          topic: 'webhook.pagination',
          source: 'webhook',
          correlation_id: '',
          dispatch_status: 'published_to_bus',
          created_at: `2026-07-30T00:00:0${sequence}Z`,
        })),
        total: 3,
      },
    });
  });

  await navigateInApp(page, '/events?topic=webhook.pagination');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('#3');
  await expect(rows.nth(1)).toContainText('#2');
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('#1');
  expect(offsets).toEqual([0, 2]);
  expect(topicsRequested).toBe(true);
});

test('loads webhook event detail through one trace request', async ({ page }) => {
  await login(page);
  const eventRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/events/event-trace')) eventRequests.push(path);
  });
  await page.route('**/api/events/event-trace/trace', (route) =>
    route.fulfill({
      json: {
        event: {
          event_id: 'event-trace',
          sequence: 1,
          topic: 'webhook.trace',
          source: 'webhook',
          correlation_id: 'corr-trace',
          dispatch_status: 'published_to_bus',
          created_at: '2026-07-30T00:00:01Z',
        },
        runs: [],
        sandboxes: [],
        descendants_truncated: false,
      },
    }),
  );

  await navigateInApp(page, '/events/event-trace');
  await expect(page.getByRole('heading', { name: 'Webhook 事件详情' })).toBeVisible();
  expect(eventRequests).toEqual(['/api/events/event-trace/trace']);
});

async function assertTabRailHasNoScrollbar(page: Page): Promise<void> {
  const tabRail = page.locator('[data-tab-scroll]');
  await expect(tabRail).toBeVisible();
  expect(
    await tabRail.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrollbarWidth: getComputedStyle(element).scrollbarWidth,
    })),
  ).toEqual({ overflowY: 'hidden', scrollbarWidth: 'none' });
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
  await ensureWebhookAcceptanceAgent(page);
  const projectResponse = await page.request.post('/agentcompose.v2.ProjectService/GetProject', {
    data: { project: { name: 'ui-agents' }, includeSpec: true },
  });
  const projectBody = (await projectResponse.json()) as {
    project: {
      summary: { projectId: string };
      schedulers: Array<{ agentName: string; displayName: string; triggerCount: number }>;
      spec: { agents: Array<Record<string, unknown>> };
    };
  };
  const scheduler = projectBody.project.schedulers.find((item) => item.displayName === webhookSchedulerDisplayName);
  expect(scheduler).toBeTruthy();
  await navigateInApp(
    page,
    `/projects/${encodeURIComponent(projectBody.project.summary.projectId)}/automations?agent=${encodeURIComponent(scheduler!.agentName)}`,
  );
  await expect(page.getByRole('heading', { name: '自动化', exact: true })).toBeVisible();
  const taskRow = page.locator('tbody tr:visible, article:visible').filter({ hasText: webhookSchedulerDisplayName });
  if (!(await taskRow.isVisible())) await page.getByRole('button', { name: /^全部 \d+$/ }).click();
  await expect(taskRow).toBeVisible();

  const agents = projectBody.project.spec.agents.map((agent) => {
    const driver =
      (agent.driver as { name?: string; docker?: unknown } | undefined)?.name === 'docker'
        ? { ...(agent.driver as Record<string, unknown>), docker: {} }
        : agent.driver;
    return agent.name === scheduler!.agentName
      ? {
          ...agent,
          driver,
          scheduler: {
            ...(agent.scheduler as Record<string, unknown>),
            script,
            triggers: [],
          },
        }
      : { ...agent, driver };
  });
  const applyResponse = await page.request.post('/agentcompose.v2.ProjectService/ApplyProject', {
    data: { spec: { ...projectBody.project.spec, agents } },
  });
  expect(applyResponse.ok(), await applyResponse.text()).toBeTruthy();
  const applied = (await applyResponse.json()) as {
    applied?: boolean;
    unchanged?: boolean;
    issues?: Array<{ path?: string; message?: string }>;
  };
  expect(
    applied.applied || applied.unchanged,
    (applied.issues ?? []).map((issue) => `${issue.path ?? ''}: ${issue.message ?? ''}`).join('\n'),
  ).toBe(true);

  await expect
    .poll(async () => {
      const response = await page.request.post('/agentcompose.v2.ProjectService/GetProject', {
        data: { project: { projectId: projectBody.project.summary.projectId } },
      });
      const body = (await response.json()) as { project: { schedulers: typeof projectBody.project.schedulers } };
      return (
        body.project.schedulers.find((item) => item.displayName === webhookSchedulerDisplayName)?.triggerCount ?? 0
      );
    })
    .toBe(2);
}

async function ensureWebhookAcceptanceAgent(page: Page): Promise<void> {
  await page.evaluate(
    async ({ image, script, agentScript, displayName }) => {
      const { projectClient } = await import('/src/api/client.ts');
      const { AgentSpec, DockerDriverSpec, DriverSpec, ProjectSpec, SchedulerSpec } =
        await import('/src/gen/agentcompose/v2/agentcompose_pb.ts');
      const current = await projectClient.getProject({
        project: { selector: { case: 'name', value: 'ui-agents' } },
        includeSpec: true,
      });
      if (!current.project?.spec) throw new Error('ui-agents project is not available');
      const dockerDriver = () =>
        new DriverSpec({
          name: 'docker',
          config: { case: 'docker', value: new DockerDriverSpec() },
        });
      const hasWebhookAgent = current.project.spec.agents.some((agent) => agent.name === 'ui-webhook-regression-agent');
      const normalizedAgents = current.project.spec.agents.map(
        (agent) =>
          new AgentSpec({
            ...agent,
            driver: agent.driver?.name === 'docker' && !agent.driver.config.case ? dockerDriver() : agent.driver,
            scheduler:
              agent.name === 'llm-shell-regression-agent' && agent.scheduler?.script !== agentScript
                ? new SchedulerSpec({ ...agent.scheduler, script: agentScript })
                : agent.scheduler,
          }),
      );
      const oldAgentAlreadySanitized = current.project.spec.agents.every(
        (agent) => agent.name !== 'llm-shell-regression-agent' || agent.scheduler?.script === agentScript,
      );
      if (hasWebhookAgent && oldAgentAlreadySanitized) return;
      const response = await projectClient.applyProject({
        spec: new ProjectSpec({
          ...current.project.spec,
          agents: [
            ...normalizedAgents,
            ...(hasWebhookAgent
              ? []
              : [
                  new AgentSpec({
                    name: 'ui-webhook-regression-agent',
                    provider: 'codex',
                    model: 'feature/gpt-5.6-luna',
                    image,
                    driver: dockerDriver(),
                    enabled: true,
                    displayName: 'Webhook 验收智能体',
                    description: '无远程依赖，用于 Webhook 与事件页面回归。',
                    scheduler: new SchedulerSpec({
                      enabled: true,
                      script,
                      sandboxPolicy: 2,
                      concurrencyPolicy: 1,
                      displayName,
                      description: 'Webhook 与事件关联执行环境回归。',
                    }),
                  }),
                ]),
          ],
        }),
      });
      if (!response.applied && !response.unchanged) {
        throw new Error(response.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
      }
    },
    {
      image: e2eGuestImage,
      script: webhookAutomationScript,
      agentScript: agentShellAutomationScript,
      displayName: webhookSchedulerDisplayName,
    },
  );
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
  await expect(page.getByRole('heading', { name: 'Agent-Compose', exact: true })).toBeVisible();
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

  await navigateInApp(page, '/sandboxes');
  await expect(page.locator('thead th').first()).toContainText('智能体');
  const exceptionalRuns = (await (await page.request.get('/api/ui/v1/runs/unlinked?limit=1')).json()) as {
    items?: unknown[];
  };
  await expect(page.getByRole('button', { name: '运行异常', exact: true })).toHaveCount(
    exceptionalRuns.items?.length ? 1 : 0,
  );

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

test('keeps product terminology concise and raw audit values in request details', async ({ page }) => {
  await page.route('**/api/ui/v1/audit/events?*', async (route) => {
    await route.fulfill({
      json: {
        items: [
          {
            id: 'audit-terminology-1',
            occurredAt: '2026-07-27T03:00:00Z',
            actor: {
              id: 'local:admin',
              source: 'local',
              username: 'admin',
              displayName: 'admin',
              authMethod: 'password',
            },
            category: 'project',
            action: 'ApplyProject',
            resourceType: 'project_scheduler',
            resourceId: 'scheduler-terminology-1',
            method: 'POST',
            path: '/agentcompose.v2.ProjectService/ApplyProject',
            outcome: 'success',
            status: 200,
            durationMs: 18,
            requestId: 'request-terminology-1',
            remoteIp: '127.0.0.1',
            userAgent: 'playwright',
          },
          {
            id: 'audit-login-1',
            occurredAt: '2026-07-27T03:01:00Z',
            actor: { username: 'admin', displayName: 'admin' },
            category: 'auth',
            action: 'login',
            outcome: 'success',
            status: 200,
            durationMs: 1,
          },
        ],
        nextCursor: '',
        hasMore: false,
      },
    });
  });

  await login(page);
  for (const route of ['/projects', '/sandboxes', '/events', '/settings', '/audit']) {
    await navigateInApp(page, route);
    const visibleText = await page.locator('body').innerText();
    expect(visibleText).not.toMatch(
      /project_scheduler|agent_definition|PROJECT_CHANGE_|Candidate:|daemon|Spec hash|Scheduler Run ID/,
    );
    expect(visibleText).not.toMatch(/\bSandbox\b/);
  }

  const auditAction = page.getByTitle('ApplyProject');
  await expect(auditAction).toHaveText('部署项目');
  await expect(page.getByRole('table').getByText('自动化配置 · scheduler-termin', { exact: true })).toBeVisible();
  await auditAction.click();
  await expect(page.getByText('ApplyProject', { exact: true })).not.toBeVisible();
  await page.getByText('请求详情', { exact: true }).click();
  await expect(page.getByText('ApplyProject', { exact: true })).toBeVisible();
  await expect(page.getByText('project_scheduler', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /复制\s+审计事件 ID/ })).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();

  const loginRow = page.getByRole('table').getByRole('row').filter({ hasText: '登录' });
  await loginRow.getByRole('cell').first().click();
  await expect(page.getByRole('heading', { name: '审计详情' })).toBeVisible();
  await expect(page.getByText('系统操作')).toHaveCount(0);
  await expect(page.getByText('—', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('button', { name: '切换语言' }).click();
  await navigateInApp(page, '/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByText('Manage global settings and access', { exact: true })).toBeVisible();
  await navigateInApp(page, '/audit');
  await expect(page.getByRole('heading', { name: 'Audit Logs', exact: true })).toBeVisible();
  await expect(page.getByText('View sign-ins and changes', { exact: true })).toBeVisible();
});

test('keeps primary pages within phone and tablet viewports', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  const navigationButton = page.getByRole('button', { name: '打开导航' });
  await expect(navigationButton).toBeVisible();
  await navigationButton.click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await page.getByRole('button', { name: '事件', exact: true }).click();
  await expect(page).toHaveURL(/\/events(?:\?.*)?$/);

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    for (const route of ['/', '/projects', '/sandboxes', '/runs/unlinked', '/events', '/settings', '/audit']) {
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

test('keeps run and event headers compact on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);

  await navigateInApp(page, '/sandboxes');
  const runHeader = await page.locator('[data-page-header]').boundingBox();
  expect(runHeader!.height).toBeLessThanOrEqual(56);
  await expect(page.locator('[data-route-scroll="sandboxes"]:visible')).toBeVisible();

  await navigateInApp(page, '/events');
  const [eventHeader, eventToolbar] = await Promise.all([
    page.locator('[data-page-header]').boundingBox(),
    page.locator('[data-collection-toolbar]').boundingBox(),
  ]);
  expect(eventHeader!.height).toBeLessThanOrEqual(56);
  expect(eventToolbar!.height).toBeLessThanOrEqual(52);

  if (retainedLinkedWebhookEventId) {
    await navigateInApp(page, `/events/${retainedLinkedWebhookEventId}`);
    const detailHeader = await page.locator('[data-page-header]').boundingBox();
    expect(detailHeader!.height).toBeLessThanOrEqual(56);
    await expect(page.locator('[data-event-summary-bar]')).toHaveCount(0);
    await expect(page.locator('[data-page-header]').getByRole('button', { name: '复制 Event ID' })).toBeVisible();
    await expect(page.locator('[data-sandbox-workbench]')).toBeVisible();
  }
});

test('selects the first project and opens the first execution environment', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);

  await navigateInApp(page, '/projects');
  const projectFrame = page.locator('[data-page-frame]');
  await expect(projectFrame.locator('aside button.bg-accent').first()).toBeVisible();
  await expect(projectFrame.locator('main h2')).not.toHaveText('');
  await expect(page).toHaveURL(/\/projects$/);

  await navigateInApp(page, '/sandboxes');
  const firstSandbox = page.locator('tbody tr').first();
  await expect(firstSandbox).toBeVisible();
  await firstSandbox.click();
  await expect(page).toHaveURL(/\/sandboxes\/[^/]+$/);
  await expect(page.locator('[data-sandbox-workbench] h2')).not.toHaveText('');
});

test('previews the deployed project YAML without edit actions', async ({ page }) => {
  await login(page);
  await navigateInApp(page, '/projects');
  await page.locator('[data-page-frame] aside button').filter({ hasText: 'ui-agents' }).click();
  await page.getByRole('button', { name: '查看 YAML', exact: true }).click();

  const dialog = page.locator('[data-project-yaml-dialog]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '当前配置' })).toBeVisible();
  await expect(dialog.getByText('只读 YAML', { exact: false })).toBeVisible();
  await expect(dialog.locator('.monaco-editor')).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByRole('button', { name: /保存|部署|编辑/ })).toHaveCount(0);
  await expect
    .poll(() =>
      dialog
        .locator('.view-lines span[class^="mtk"]')
        .evaluateAll((tokens) => new Set(tokens.map((token) => token.className)).size),
    )
    .toBeGreaterThan(1);

  await dialog.getByRole('button', { name: '全屏', exact: true }).click();
  const fullscreenEditor = page.locator('[data-code-editor][data-fullscreen="true"]');
  await expect(fullscreenEditor).toBeVisible();
  await expect.poll(() => fullscreenEditor.evaluate((element) => element.parentElement === document.body)).toBe(true);
  const fullscreenBounds = await fullscreenEditor.boundingBox();
  const viewport = page.viewportSize();
  expect(fullscreenBounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(fullscreenBounds!.width).toBeGreaterThanOrEqual(viewport!.width - 1);
  expect(fullscreenBounds!.height).toBeGreaterThanOrEqual(viewport!.height - 1);
  await fullscreenEditor.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '全屏', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const dialogBounds = await dialog.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(dialogBounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByRole('button', { name: '复制 YAML', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('agents:');
  const copiedYAML = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedYAML).not.toMatch(/sk-[a-zA-Z0-9_-]{16,}/);

  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载 YAML', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('ui-agents.yaml');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('compacts execution environment metadata without altering output', async ({ page }) => {
  test.skip(!retainedSandboxId, 'requires a retained execution environment');
  await login(page);
  await navigateInApp(page, `/sandboxes/${retainedSandboxId}`);
  const workbench = page.locator('[data-sandbox-workbench]');
  await expect(workbench).toBeVisible();
  const contextBar = workbench.locator('[data-sandbox-context-bar]');
  await expect(contextBar).toHaveAttribute('data-page-header', '');
  expect((await contextBar.boundingBox())!.height).toBeLessThanOrEqual(52);
  const metadata = await contextBar.innerText();
  expect(metadata).not.toMatch(/\b[a-f\d]{32,}\b/i);
  await expect(workbench.getByRole('button', { name: /复制\s+执行环境 ID/ })).toHaveCount(1);
  await expect(contextBar.getByRole('button', { name: '复制链接' })).toBeVisible();
  await expect(workbench.getByText('环境信息', { exact: true })).toBeVisible();
});

test('only builds Jupyter links for daemon-confirmed notebook locations', async ({ page }) => {
  await page.goto('/');
  const paths = await page.evaluate(async () => {
    const { jupyterEntryHref } = await import('/src/model/jupyter.ts');
    return [
      jupyterEntryHref({
        proxyPath: '/jupyter/sandbox-1/lab',
        notebookUrl: 'https://daemon.example/jupyter/sandbox-1/lab?token=secret',
      }),
      jupyterEntryHref({ notebookUrl: 'https://daemon.example/jupyter/sandbox-2/lab?token=secret' }),
      jupyterEntryHref({ proxyPath: '/jupyter/sandbox-disabled/lab' }),
    ];
  });
  expect(paths).toEqual(['/jupyter/sandbox-1', '/jupyter/sandbox-2', '']);
  expect(paths.join('\n')).not.toContain('token');
});

test('opens a daemon-confirmed Jupyter environment', async ({ page }) => {
  test.skip(process.env.AGENT_COMPOSE_E2E_REAL_JUPYTER !== '1', 'requires explicit Jupyter runtime authorization');
  test.setTimeout(180_000);
  await login(page);
  await ensureWebhookAcceptanceAgent(page);
  const projectResponse = await page.request.get('/api/ui/v1/projects');
  const projectBody = (await projectResponse.json()) as {
    projects: Array<{ projectId: string; agents: Array<{ agentName: string }> }>;
  };
  const target = projectBody.projects
    .flatMap((project) => project.agents.map((agent) => ({ projectId: project.projectId, agentName: agent.agentName })))
    .find((agent) => agent.agentName === 'ui-webhook-regression-agent');
  test.skip(!target, 'The Jupyter acceptance Agent is not available');

  const resumedSandboxId = process.env.AGENT_COMPOSE_E2E_RESUME_JUPYTER_SANDBOX_ID ?? '';
  const sandboxId =
    resumedSandboxId ||
    (await page.evaluate(async ({ projectId, agentName }) => {
      const { runClient } = await import('/src/api/client.ts');
      let id = '';
      for await (const event of runClient.streamAgentRun({
        projectId,
        agentName,
        source: 1,
        cleanupPolicy: 2,
        command: "printf 'JUPYTER_SANDBOX_READY\\n'",
        jupyter: { enabled: true, expose: true },
      })) {
        id ||= event.run?.sandboxId || event.sandboxId;
      }
      return id;
    }, target!));
  expect(sandboxId).toBeTruthy();

  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const { sandboxClient } = await import('/src/api/client.ts');
          const { jupyterEntryHref } = await import('/src/model/jupyter.ts');
          const sandbox = (await sandboxClient.getSandbox({ sandboxId: id })).sandbox;
          return {
            notebookUrl: sandbox?.notebookUrl ?? '',
            entryHref: jupyterEntryHref(sandbox),
          };
        }, sandboxId),
      { timeout: 60_000 },
    )
    .toMatchObject({ notebookUrl: expect.stringContaining('/jupyter/'), entryHref: `/jupyter/${sandboxId}` });
  const location = await page.evaluate(async (id) => {
    const { sandboxClient } = await import('/src/api/client.ts');
    const sandbox = (await sandboxClient.getSandbox({ sandboxId: id })).sandbox;
    return { notebookUrl: sandbox?.notebookUrl ?? '', proxyPath: sandbox?.proxyPath ?? '' };
  }, sandboxId);
  const response = await page.request.get(`/jupyter/${sandboxId}`);
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBeTruthy();
  expect(response.headers()['content-type']).toContain('text/html');

  const token = new URL(location.notebookUrl, page.url()).searchParams.get('token') ?? '';
  expect(token).toBeTruthy();
  const terminalResponse = await page.request.post(
    `/jupyter/${sandboxId}/api/terminals?token=${encodeURIComponent(token)}`,
    { data: {} },
  );
  expect(terminalResponse.ok(), `${terminalResponse.status()} ${await terminalResponse.text()}`).toBeTruthy();
  const terminal = (await terminalResponse.json()) as { name?: string };
  expect(terminal.name).toBeTruthy();
  const bashOutput = await page.evaluate(
    ({ id, name, accessToken }) =>
      new Promise<string>((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(
          `${protocol}//${location.host}/jupyter/${encodeURIComponent(id)}/terminals/websocket/${encodeURIComponent(name)}?token=${encodeURIComponent(accessToken)}`,
        );
        let output = '';
        const timeout = window.setTimeout(() => {
          socket.close();
          reject(new Error(`Bash terminal produced no output: ${output}`));
        }, 15_000);
        socket.onopen = () => {
          socket.send(JSON.stringify(['set_size', 24, 100, 800, 600]));
          socket.send(JSON.stringify(['stdin', "printf 'JUPYTER_BASH_OK\\n'\r"]));
        };
        socket.onerror = () => reject(new Error('Jupyter terminal WebSocket failed'));
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as [string, string];
          if (message[0] !== 'stdout') return;
          output += message[1];
          if (!output.includes('JUPYTER_BASH_OK')) return;
          window.clearTimeout(timeout);
          socket.close();
          resolve(output);
        };
      }),
    { id: sandboxId, name: terminal.name!, accessToken: token },
  );
  expect(bashOutput).toContain('JUPYTER_BASH_OK');

  if (!resumedSandboxId && process.env.AGENT_COMPOSE_E2E_RETAIN_JUPYTER !== '1') {
    await page.evaluate(async (id) => {
      const { sandboxClient } = await import('/src/api/client.ts');
      await sandboxClient.removeSandbox({ sandboxId: id, force: true });
    }, sandboxId);
  } else console.log(`retained Jupyter sandbox: ${sandboxId}`);
});

test('restores complete successful replies around file changes', async ({ page }) => {
  await page.goto('/login');
  const result = await page.evaluate(async () => {
    const { presentAgentOutput } = await import('/src/model/agent-output.ts');
    const { conversationTurns } = await import('/src/model/conversation.ts');
    const output = presentAgentOutput('准备创建文件。\n[file_change]\nadd: /workspace/hello.py\n文件已保存。');
    const turns = conversationTurns([
      {
        id: 'event-user',
        runId: 'run-file-change',
        source: '创建文件',
        output: '',
        type: 4,
        exitCode: 0,
        success: false,
        createdAt: '2026-07-27T14:42:43Z',
        agent: 'agent-file-change',
        agentSessionId: '',
        stopReason: '',
        running: false,
      },
      {
        id: 'event-agent',
        runId: 'run-file-change',
        source: '',
        output,
        type: 4,
        exitCode: 0,
        success: true,
        createdAt: '2026-07-27T14:42:44Z',
        agent: 'codex',
        agentSessionId: '',
        stopReason: '',
        running: false,
      },
    ]);
    return { output, turns };
  });
  expect(result.output).toBe('准备创建文件。\n\n文件已保存。');
  expect(result.turns).toEqual([
    expect.objectContaining({
      runId: 'run-file-change',
      prompt: '创建文件',
      output: '准备创建文件。\n\n文件已保存。',
      success: true,
      stopReason: '',
    }),
  ]);
});

test('builds one execution timeline without repeating conversation output', async ({ page }) => {
  await page.goto('/login');
  const result = await page.evaluate(async () => {
    const { RunEvent, RunEventKind } = await import('/src/gen/agentcompose/v2/agentcompose_pb.ts');
    const { buildRunExecutionEvents } = await import('/src/model/run-execution.ts');
    const events = [
      new RunEvent({ id: 'user', kind: RunEventKind.USER_MESSAGE, text: 'hello' }),
      new RunEvent({ id: 'assistant', kind: RunEventKind.AGENT_MESSAGE, text: 'done' }),
      new RunEvent({ id: 'status', kind: RunEventKind.STATUS, success: true }),
    ];
    const failed = [
      new RunEvent({
        id: 'failed',
        kind: RunEventKind.STATUS,
        stopReason: 'sandbox start failed: context canceled',
      }),
    ];
    return {
      covered: buildRunExecutionEvents(events, [], 'done', '').map((event) => event.title),
      unique: buildRunExecutionEvents(events, [], 'shell output', '').map((event) => event.title),
      failure: buildRunExecutionEvents(failed, [], '', '').map((event) => event.summary),
      coveredFailure: buildRunExecutionEvents(
        failed,
        [],
        'codex run failed: sandbox start failed: context canceled',
        '',
      ).map((event) => event.title),
    };
  });
  expect(result).toEqual({
    covered: ['运行完成'],
    unique: ['运行完成', '运行输出'],
    failure: ['sandbox start failed: context canceled'],
    coveredFailure: ['执行失败'],
  });
});

test('matches an active run to its persisted conversation turn', async ({ page }) => {
  await page.goto('/login');
  const result = await page.evaluate(async () => {
    const { conversationResponseState, isActiveConversationTurn } = await import('/src/model/conversation.ts');
    const turn = {
      id: 'event-user',
      runId: 'run-current',
      prompt: 'current prompt',
      output: '',
      createdAt: '',
    };
    return {
      matches: [
        isActiveConversationTurn(turn, 'run-current', 'run-current', 'current prompt'),
        isActiveConversationTurn(turn, '', 'run-current', 'current prompt'),
        isActiveConversationTurn(turn, 'run-next', 'run-current', 'current prompt'),
      ],
      responses: [
        conversationResponseState('running', '', ''),
        conversationResponseState('running', 'partial', ''),
        conversationResponseState('stopped', '', ''),
        conversationResponseState('failed', '', 'agent failed'),
        conversationResponseState('success', '', ''),
      ],
    };
  });
  expect(result).toEqual({
    matches: [true, true, false],
    responses: ['streaming', 'output', 'none', 'error', 'empty'],
  });
});

test('does not expose image building in the UI', async ({ page }) => {
  await login(page);
  await navigateInApp(page, '/images');
  await expect(page.getByRole('heading', { name: '镜像' })).toBeVisible();
  await expect(page.getByRole('button', { name: '构建镜像' })).toHaveCount(0);
  await expect(page.getByPlaceholder('Dockerfile')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '拉取' })).toBeVisible();
  const capabilities = await page.evaluate(async () => {
    const api = await import('/src/api/resources.ts');
    return {
      list: typeof api.listImages,
      pull: typeof api.pullImage,
      inspect: typeof api.inspectImage,
      remove: typeof api.removeImage,
      build: 'buildImage' in api,
    };
  });
  expect(capabilities).toEqual({
    list: 'function',
    pull: 'function',
    inspect: 'function',
    remove: 'function',
    build: false,
  });
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

  const projectsResponse = await page.request.get('/api/ui/v1/projects');
  const projectsBody = (await projectsResponse.json()) as {
    projects: Array<{ projectId: string; editable: boolean; agents: Array<unknown> }>;
  };
  const project = projectsBody.projects.find((item) => item.editable && item.agents.length > 0);
  test.skip(!project, 'No editable Project with Agents is available');
  await navigateInApp(page, `/projects/${encodeURIComponent(project!.projectId)}/automations`);
  const createButton = page.getByRole('button', { name: '配置自动化' });
  await createButton.hover();
  await page.waitForTimeout(500);

  const startedAt = Date.now();
  await createButton.click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  expect(Date.now() - startedAt, 'the intent-preloaded editor took too long to appear').toBeLessThan(2_500);
  expect(editorRequests.length, 'Monaco was not loaded for the editor').toBeGreaterThan(0);
});

test('uses explicit document, master-detail, and workbench scrolling across desktop sizes', async ({ page }) => {
  test.skip(
    !retainedSandboxId || !retainedRunId || !retainedLiveWebhookEventId,
    'requires retained run, execution environment, and event resources',
  );
  test.setTimeout(90_000);
  await login(page);
  const layoutRoutes = [
    ...routes,
    `/sandboxes/${retainedSandboxId}`,
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
  test.skip(
    !retainedLinkedWebhookEventId || !retainedSandboxId,
    'requires retained event and execution environment resources',
  );
  await login(page);
  await page.setViewportSize({ width: 1280, height: 720 });

  await navigateInApp(page, '/projects');
  const projectList = page.locator('aside [data-scroll-pane]');
  await page.locator('[data-page-frame] aside button').filter({ hasText: 'ui-agents' }).click();
  await page.getByRole('button', { name: /LLM Shell Regression Agent/ }).click();
  const agentHeading = page.getByRole('heading', { name: 'LLM Shell Regression Agent' });
  await expect(agentHeading).toBeVisible();
  const headingTop = await agentHeading.evaluate((element) => element.getBoundingClientRect().top);
  await projectList.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  expect(await agentHeading.evaluate((element) => element.getBoundingClientRect().top)).toBe(headingTop);

  await navigateInApp(page, `/events/${retainedLinkedWebhookEventId}`);
  const eventWorkbench = page.locator('[data-sandbox-workbench]');
  await expect(eventWorkbench).toBeVisible();
  expect(
    await page.locator('main[data-scroll-root]').evaluate((element) => element.scrollHeight - element.clientHeight),
    'the embedded event workbench makes the page scroll',
  ).toBeLessThanOrEqual(1);

  await navigateInApp(page, `/sandboxes/${retainedSandboxId}`);
  for (const tab of ['对话', '运行日志', '终端']) {
    if ((await page.getByRole('tab', { name: tab, exact: true }).count()) === 0) continue;
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
    expect(
      await page.locator('main[data-scroll-root]').evaluate((element) => element.scrollHeight - element.clientHeight),
      `${tab} makes the Run workbench page scroll`,
    ).toBeLessThanOrEqual(1);
  }

  await navigateInApp(page, '/settings');
  for (const tab of ['全局环境', '能力网关', 'Webhook', '工作目录', '鉴权']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
    expect(
      await page.locator('main[data-scroll-root]').evaluate((element) => element.scrollHeight - element.clientHeight),
      `${tab} makes the Settings workbench page scroll`,
    ).toBeLessThanOrEqual(1);
  }
});

test('keeps settings and execution tabs scrollable without visible scrollbars', async ({ page }) => {
  test.skip(!retainedSandboxId, 'requires a retained execution environment');
  await login(page);
  await navigateInApp(page, '/settings');
  await assertTabRailHasNoScrollbar(page);

  await navigateInApp(page, `/sandboxes/${retainedSandboxId}`);
  await assertTabRailHasNoScrollbar(page);
});

test('supports theme, density, command palette, and browser navigation', async ({ page }) => {
  await login(page);

  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder('跳转页面，或输入 ID 直达资源…')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByLabel('切换主题').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByLabel('切换密度').click();
  await page.getByRole('button', { name: '项目', exact: true }).click();
  await expect(page).toHaveURL(/\/projects/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test('distinguishes semantic statuses and the selected tab', async ({ page }) => {
  test.skip(
    !retainedLiveWebhookEventId || !retainedSandboxId,
    'requires retained event and execution environment resources',
  );
  await login(page);
  await navigateInApp(page, '/sandboxes');
  const failedStatus = page.locator('table [data-semantic-status="failed"]').first();
  await expect(failedStatus).toBeVisible();
  const failedColor = await failedStatus.evaluate((element) => getComputedStyle(element).color);

  await navigateInApp(page, `/events/${retainedLiveWebhookEventId}`);
  const successStatus = page.locator('[data-semantic-status="success"]:visible').first();
  await expect(successStatus).toBeVisible();
  const successColor = await successStatus.evaluate((element) => getComputedStyle(element).color);
  expect(failedColor).not.toBe(successColor);

  await navigateInApp(page, `/sandboxes/${retainedSandboxId}`);
  const activeTab = page.getByRole('tab', { name: '对话', exact: true });
  const inactiveTab = page.getByRole('tab', { name: '终端', exact: true });
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

test('filters execution environments and restores the filtered view', async ({ page }) => {
  await login(page);
  await navigateInApp(page, '/sandboxes');
  await expect(page.getByRole('heading', { name: '运行记录' })).toBeVisible();
  await expect(page.getByPlaceholder('输入执行环境 ID')).toBeVisible();
  await expect(page.getByRole('button', { name: '查找', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '直达', exact: true })).toHaveCount(0);

  await page.getByLabel('按状态筛选').selectOption('failed');
  await expect(page).toHaveURL(/\/sandboxes\?status=failed$/);
  await expect(page.locator('tbody [data-semantic-status="failed"]').first()).toBeVisible();
  await expect(page.locator('tbody [data-semantic-status]:not([data-semantic-status="failed"])')).toHaveCount(0);

  await page.locator('tbody tr').first().click();
  await expect(page).toHaveURL(/\/sandboxes\/[a-f0-9]+$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/sandboxes\?status=failed$/);
  await expect(page.getByLabel('按状态筛选')).toHaveValue('failed');

  await page.getByLabel('按状态筛选').selectOption('');
  await expect(page).toHaveURL(/\/sandboxes$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('按项目筛选')).toBeVisible();
  await expect(page.getByLabel('按状态筛选')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('keeps execution actions sticky and restores list scroll on browser history', async ({ page }) => {
  await login(page);
  await navigateInApp(page, '/sandboxes');
  const header = page.locator('[data-page-header]');
  const list = page.locator('[data-route-scroll="sandboxes"]:visible');
  await expect(page.getByRole('heading', { name: '运行记录', exact: true })).toBeVisible();
  await expect.poll(() => page.getByRole('row').count()).toBeGreaterThan(1);
  await page.addStyleTag({ content: '[data-route-scroll="sandboxes"] table { min-height: calc(100% + 48rem); }' });
  const headerTop = await header.evaluate((element) => element.getBoundingClientRect().top);
  await list.evaluate((element) => element.scrollTo(0, 480));
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(400);
  expect(await header.evaluate((element) => element.getBoundingClientRect().top)).toBe(headerTop);

  await page
    .getByRole('row')
    .nth(1)
    .evaluate((element) => (element as HTMLElement).click());
  await expect(page).toHaveURL(/\/sandboxes\/[a-f0-9]+$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/sandboxes$/);
  await expect
    .poll(() =>
      list.evaluate((element) => {
        const available = element.scrollHeight - element.clientHeight;
        return Math.abs(element.scrollTop - Math.min(480, available));
      }),
    )
    .toBeLessThanOrEqual(1);
});

test('opens the live webhook event from the authenticated event center', async ({ page }) => {
  test.skip(!retainedLiveWebhookEventId, 'requires a retained webhook event');
  await page.goto(`/events/${retainedLiveWebhookEventId}`);
  await expect(page.getByRole('heading', { name: 'Agent-Compose', exact: true })).toBeVisible();
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill(e2ePassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/events/${retainedLiveWebhookEventId}$`));
  await expect(page.getByRole('heading', { name: 'Webhook 事件详情' })).toBeVisible();

  await navigateInApp(page, '/events?topic=webhook.ui-regression.acceptance');
  await expect(page.getByRole('button', { name: /webhook\.ui-regression\.acceptance/ })).toBeVisible();
  const acceptedEvent = page.getByRole('table').getByTitle(retainedLiveWebhookEventId);
  await expect(acceptedEvent).toBeVisible();
  await acceptedEvent.click();
  await expect(page.getByRole('heading', { name: 'Webhook 事件详情' })).toBeVisible();
  await expect(page.getByText(/没有产生或绑定对话执行环境/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '自动化执行' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '事件时间线' })).toBeVisible();
  await expect(page.getByText('agent-compose-ui:live-acceptance-v2', { exact: true })).toBeVisible();
  await expect(page.getByText('Webhook Payload')).toHaveCount(0);
  await expect(page.getByText(/WEBHOOK_LIVE_ACCEPTANCE_OK/)).toHaveCount(0);
  await expect(page.getByText('no_subscriber', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/events/${retainedLiveWebhookEventId}$`));
  await expect(page.getByRole('heading', { name: 'Webhook 事件详情' })).toBeVisible();
  await expect(page.getByRole('button', { name: '复制链接' })).toBeVisible();
});

test('shows retained event execution environments in place', async ({ page }) => {
  test.skip(!retainedLinkedWebhookEventId, 'requires a retained event with an execution environment');
  await login(page);
  await navigateInApp(page, `/events/${retainedLinkedWebhookEventId}`);
  await expect(page.locator('[data-sandbox-workbench]')).toBeVisible();

  const sessionsResponse = await page.request.get(`/api/events/${retainedLinkedWebhookEventId}/sessions`);
  const sessions = (await sessionsResponse.json()) as {
    sessions?: Array<{ session_id?: string; sandbox_id?: string }>;
    sandboxes?: Array<{ session_id?: string; sandbox_id?: string }>;
  };
  const sandboxCount = new Set(
    (sessions.sessions ?? sessions.sandboxes ?? []).map((item) => item.session_id || item.sandbox_id).filter(Boolean),
  ).size;

  const desktopSelector = page.locator('[data-sandbox-selector="desktop"]');
  if (sandboxCount > 1) {
    await expect(desktopSelector).toBeVisible();
    await expect(desktopSelector.getByRole('button')).toHaveCount(sandboxCount);
    expect(await desktopSelector.innerText()).not.toMatch(/[a-f\d]{32,}/i);
  } else await expect(desktopSelector).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  if (sandboxCount > 1) {
    await expect(page.locator('[data-sandbox-selector="mobile"]')).toBeVisible();
    await expect(desktopSelector).toBeHidden();
  } else await expect(page.locator('[data-sandbox-selector="mobile"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('copies full resource identifiers and deep links without navigating rows', async ({ page }) => {
  test.skip(!retainedRunId || !retainedLinkedWebhookEventId, 'requires retained run and event resources');
  await login(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await navigateInApp(page, '/sandboxes');
  const sandboxCopy = page.getByRole('button', { name: '复制 执行环境 ID' }).first();
  const fullSandboxId = await sandboxCopy.locator('..').locator('span[title]').getAttribute('title');
  expect(fullSandboxId).toBeTruthy();
  await sandboxCopy.click();
  await expect(page.getByRole('status').filter({ hasText: '已复制' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fullSandboxId);
  await expect(page).toHaveURL(/\/sandboxes$/);

  await navigateInApp(page, `/runs/${retainedRunId}`);
  await page.locator('[data-page-header]').getByRole('button', { name: '复制 运行 ID' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(retainedRunId);
  await page.getByRole('button', { name: '复制链接' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  await page.getByRole('tab', { name: '终端' }).click();
  await expect(page.getByRole('button', { name: '复制 执行环境 ID' })).toBeVisible();

  await navigateInApp(page, `/events/${retainedLinkedWebhookEventId}`);
  await page.getByRole('button', { name: '复制 Event ID' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(retainedLinkedWebhookEventId);
  await page.getByRole('button', { name: '复制链接' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  await expect(page.getByRole('button', { name: '复制 自动化运行 ID' }).first()).toBeVisible();

  const detailTime = page.locator('time[datetime]').first();
  await expect(detailTime).toHaveAttribute('datetime', /T/);
  await expect(detailTime).toHaveAttribute('title', /Asia\/Shanghai/);

  await navigateInApp(page, '/sandboxes');
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
  const fallbackCopy = page.getByRole('button', { name: '复制 执行环境 ID' }).first();
  const fallbackSandboxId = await fallbackCopy.locator('..').locator('span[title]').getAttribute('title');
  await fallbackCopy.click();
  await expect(page.getByRole('status').filter({ hasText: '已复制' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __fallbackClipboardValue?: string }).__fallbackClipboardValue),
    )
    .toBe(fallbackSandboxId);
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
  await expect(page.getByRole('heading', { name: 'Webhook 事件详情' })).toBeVisible();
  await expect(page.getByText(/没有产生或绑定对话执行环境/)).toHaveCount(0);
  await expect(page.getByText('Webhook Payload')).toHaveCount(0);
  await expect(page.getByText(/WEBHOOK_AUTOMATION_TRIGGER_OK/)).toHaveCount(0);
  await expect(page.getByText('运行成功', { exact: true })).toBeVisible();
  await expect(page.getByText('ui-webhook-event', { exact: false })).toBeVisible();
  await expect(page.getByText('执行 ID', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/events/${accepted.event_id}$`));
  await expect(page.getByText('run_succeeded')).toHaveCount(0);
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
  await expect(page.getByRole('heading', { name: 'Webhook 事件详情' })).toBeVisible();
  const workbench = page.locator('[data-sandbox-workbench]');
  await expect(workbench.getByText('WEBHOOK_AGENT_CONVERSATION_OK', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('ui-webhook-agent-conversation', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '关联运行' })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/events/${accepted.event_id}$`));
});

test('shows an event execution context when a webhook creates a sandbox', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);

  try {
    await configureWebhookAutomation(page, webhookShellContextScript);
    const response = await page.request.post('/api/webhooks/webhook.ui-regression.acceptance', {
      headers: {
        Authorization: `Bearer ${webhookAccessToken}`,
        'Idempotency-Key': `agent-compose-ui-webhook-shell-${Date.now()}`,
        'X-Correlation-ID': 'agent-compose-ui:webhook-shell-context',
      },
      data: { intent: 'linked-shell-context' },
    });
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as { event_id: string };

    await expect
      .poll(
        async () => {
          const sessionsResponse = await page.request.get(`/api/events/${accepted.event_id}/sessions`);
          const body = (await sessionsResponse.json()) as { sessions?: unknown[]; sandboxes?: unknown[] };
          return (body.sessions ?? body.sandboxes ?? []).length;
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    await navigateInApp(page, `/events/${accepted.event_id}`);
    const workbench = page.locator('[data-sandbox-workbench]');
    await expect(workbench).toBeVisible();
    const logs = workbench.getByRole('tabpanel', { name: '运行日志' });
    await expect(logs).toContainText('WEBHOOK_SHELL_CONTEXT_1', {
      timeout: 30_000,
    });
    await expect(logs).not.toContainText('WEBHOOK_SHELL_CONTEXT_3');
    await expect(logs).toContainText('WEBHOOK_SHELL_CONTEXT_2', { timeout: 10_000 });
    await expect(logs).toContainText('WEBHOOK_SHELL_CONTEXT_3', { timeout: 10_000 });
    await expect(workbench.getByText('失败', { exact: true })).toHaveCount(0);
    await expect(workbench.getByRole('link', { name: 'Jupyter', exact: true })).toHaveCount(0);
    await expect(page.getByText(/linked-shell-context/)).toHaveCount(0);
  } finally {
    await configureWebhookAutomation(page, webhookAutomationScript);
  }
});

test('switches one event between multiple conversation sandboxes', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);

  try {
    await configureWebhookAutomation(page, webhookMultiConversationScript);
    const response = await page.request.post('/api/webhooks/webhook.ui-regression.acceptance', {
      headers: {
        Authorization: `Bearer ${webhookAccessToken}`,
        'Idempotency-Key': `agent-compose-ui-webhook-multi-conversation-${Date.now()}`,
        'X-Correlation-ID': 'agent-compose-ui:webhook-multi-conversation',
      },
      data: { intent: 'multiple-conversation-sandboxes' },
    });
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as { event_id: string };

    const linkedSessionIds = async (): Promise<string[]> => {
      const sessionsResponse = await page.request.get(`/api/events/${accepted.event_id}/sessions`);
      const body = (await sessionsResponse.json()) as {
        sessions?: Array<{ session_id?: string; sandbox_id?: string }>;
        sandboxes?: Array<{ session_id?: string; sandbox_id?: string }>;
      };
      return [
        ...new Set(
          (body.sessions ?? body.sandboxes ?? [])
            .map((item) => item.session_id || item.sandbox_id || '')
            .filter(Boolean),
        ),
      ];
    };
    await expect.poll(linkedSessionIds, { timeout: 180_000 }).toHaveLength(2);
    const sessionIds = await linkedSessionIds();

    await navigateInApp(page, `/events/${accepted.event_id}`);
    const desktopSelector = page.locator('[data-sandbox-selector="desktop"]');
    await expect(desktopSelector).toBeVisible();
    await expect(desktopSelector.getByRole('button')).toHaveCount(2);
    await expect(page.locator('[data-sandbox-workbench]')).toHaveCount(1);

    const secondSessionId = sessionIds[1];
    await desktopSelector.locator(`[data-sandbox-id="${secondSessionId}"]`).click();
    await expect(page.locator('[data-selected-sandbox-id]')).toHaveAttribute(
      'data-selected-sandbox-id',
      secondSessionId,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileSelector = page.locator('[data-sandbox-selector="mobile"]');
    await expect(mobileSelector).toBeVisible();
    await expect(desktopSelector).toBeHidden();
    await mobileSelector.selectOption(sessionIds[0]);
    await expect(page.locator('[data-selected-sandbox-id]')).toHaveAttribute('data-selected-sandbox-id', sessionIds[0]);
    await expect(page.locator('[data-sandbox-workbench]')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
    await configureWebhookAutomation(page, webhookAutomationScript);
  }
});

test('shows retained run diagnostics and an interactive sandbox terminal', async ({ page }) => {
  test.skip(
    !retainedRunId || !retainedFollowupRunId || !retainedProjectId || !retainedAgentName,
    'requires retained conversation and Agent resources',
  );
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
  await expect(page.locator('[data-conversation-transcript]')).toBeVisible();
  await expect(page.getByPlaceholder('搜索当前对话')).toBeVisible();
  await expect(page.getByPlaceholder('输入消息，Shift + Enter 换行')).toBeVisible();
  await expect(page.getByRole('tab', { name: '执行过程' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '原始日志' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '执行环境' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '产物' })).toHaveCount(0);

  await page.getByRole('tab', { name: '执行过程' }).click();
  const execution = page.locator('[data-run-execution-process]');
  await expect(execution).toBeVisible();
  await expect(execution.getByPlaceholder('搜索执行过程')).toBeVisible();
  await expect(page.getByRole('tab', { name: '运行事件' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '输出日志' })).toHaveCount(0);
  await expect(execution.getByText('用户消息', { exact: true })).toHaveCount(0);
  await expect(execution).toContainText(/kimi-k2\.6|503|无可用渠道/);
  await execution.getByText('原始数据', { exact: true }).click();
  await expect(execution.getByRole('button', { name: '下载输出日志' })).toBeVisible();
  await page.getByRole('tab', { name: '执行环境' }).click();
  await expect(page.getByRole('tabpanel', { name: '执行环境' }).getByText('运行方式', { exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: '执行环境' }).getByText('详细信息')).toBeVisible();

  const terminalRun = await page.evaluate(
    async ({ projectId, agentName }) => {
      const { runClient } = await import('/src/api/client.ts');
      let runId = '';
      let sandboxId = '';
      for await (const event of runClient.streamAgentRun({
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

test('stops waiting when terminal attach produces no response', async ({ page }) => {
  test.skip(!retainedRunId, 'requires a retained run');
  test.setTimeout(20_000);
  await page.routeWebSocket('**/api/terminal/attach?*', (socket) => {
    socket.onMessage(() => {});
  });
  await login(page);
  await navigateInApp(page, `/runs/${retainedRunId}/terminal`);
  const terminalPanel = page.locator('[data-terminal-panel]');
  await expect(terminalPanel.getByText('连接中', { exact: true })).toBeVisible();
  await expect(page.locator('[data-page-error]')).toContainText('终端连接超时，后端未响应', { timeout: 10_000 });
  await expect(terminalPanel.getByText('连接失败', { exact: true })).toBeVisible();
  await expect(terminalPanel.getByRole('button', { name: '连接', exact: true })).toBeVisible();
});

test('automatically connects a real terminal and accepts input', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const agentName = `terminal-agent-${Date.now()}`;
  const targetProject = 'ui-runtime-regression-20260729';
  const prepared = await page.evaluate(
    async ({ targetProject, agentName, image }) => {
      const { projectClient } = await import('/src/api/client.ts');
      const { AgentSpec, DockerDriverSpec, DriverSpec, ProjectSpec } =
        await import('/src/gen/agentcompose/v2/agentcompose_pb.ts');
      const current = await projectClient.getProject({
        project: { selector: { case: 'name', value: targetProject } },
        includeSpec: true,
      });
      if (!current.project?.summary?.projectId || !current.project.spec) {
        throw new Error(`Acceptance project ${targetProject} is not available`);
      }
      const normalizedSpec = new ProjectSpec({
        ...current.project.spec,
        agents: current.project.spec.agents.map(
          (agent) =>
            new AgentSpec({
              ...agent,
              driver:
                agent.driver?.name === 'docker' && !agent.driver.config.case
                  ? new DriverSpec({
                      name: 'docker',
                      config: { case: 'docker', value: new DockerDriverSpec() },
                    })
                  : agent.driver,
            }),
        ),
      });
      const originalSpec = normalizedSpec.toJson();
      const response = await projectClient.applyProject({
        spec: new ProjectSpec({
          ...normalizedSpec,
          agents: [
            ...normalizedSpec.agents,
            new AgentSpec({
              name: agentName,
              provider: 'codex',
              model: 'feature/gpt-5.6-luna',
              image,
              driver: new DriverSpec({
                name: 'docker',
                config: { case: 'docker', value: new DockerDriverSpec() },
              }),
              enabled: true,
            }),
          ],
        }),
      });
      if (!response.applied || response.issues.length > 0) {
        throw new Error(
          response.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n') || 'Project was not applied',
        );
      }
      return { projectId: current.project.summary.projectId, originalSpec };
    },
    { targetProject, agentName, image: e2eGuestImage },
  );
  let sandboxId = '';

  try {
    const target = await page.evaluate(
      async ({ projectId, agentName }) => {
        const { runClient } = await import('/src/api/client.ts');
        let runId = '';
        let sandboxId = '';
        for await (const event of runClient.streamAgentRun({
          projectId,
          agentName,
          source: 1,
          cleanupPolicy: 2,
          command: "printf 'TERMINAL_AUTO_CONNECT_READY\\n'",
        })) {
          runId ||= event.runId;
          sandboxId ||= event.run?.sandboxId || event.sandboxId;
        }
        if (runId && !sandboxId) sandboxId = (await runClient.getRun({ runId })).run?.summary?.sandboxId ?? '';
        return { runId, sandboxId };
      },
      { projectId: prepared.projectId, agentName },
    );
    expect(target.runId).toBeTruthy();
    expect(target.sandboxId).toBeTruthy();
    sandboxId = target.sandboxId;

    await navigateInApp(page, `/runs/${target.runId}/terminal`);
    const terminalPanel = page.locator('[data-terminal-panel]');
    await expect(terminalPanel.getByText('已连接', { exact: true })).toBeVisible({ timeout: 10_000 });
    const initialFontSize = await page
      .locator('.xterm-rows > div')
      .first()
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    await page.getByRole('button', { name: '增大终端字体' }).click();
    await expect
      .poll(() =>
        page
          .locator('.xterm-rows > div')
          .first()
          .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
      )
      .toBeGreaterThan(initialFontSize);
    const inlineSize = await terminalPanel.evaluate((element) => ({
      width: element.clientWidth,
      height: element.clientHeight,
    }));
    await page.getByRole('button', { name: '展开终端' }).click();
    await expect
      .poll(() => terminalPanel.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(inlineSize.height);
    await page.getByRole('button', { name: '还原终端' }).click();
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(terminalPanel.getByText('已连接', { exact: true })).toBeVisible();
    const terminalInput = page.getByRole('textbox', { name: 'Terminal input' });
    await terminalInput.pressSequentially('printf "TERMINAL_INPUT_OK\\n"');
    await terminalInput.press('Enter');
    await expect(page.locator('.xterm-rows')).toContainText('TERMINAL_INPUT_OK');
  } finally {
    await navigateInApp(page, '/sandboxes');
    await page.evaluate(
      async ({ prepared, sandboxId }) => {
        const { projectClient, sandboxClient } = await import('/src/api/client.ts');
        const { ProjectSpec } = await import('/src/gen/agentcompose/v2/agentcompose_pb.ts');
        if (sandboxId) await sandboxClient.removeSandbox({ sandboxId, force: true });
        const response = await projectClient.applyProject({ spec: ProjectSpec.fromJson(prepared.originalSpec) });
        if (!response.applied && !response.unchanged) throw new Error('Acceptance project was not restored');
      },
      { prepared, sandboxId },
    );
  }
});

test('streams StreamAgentRun output through the UI proxy before completion', async ({ page }) => {
  test.skip(!retainedProjectId || !retainedAgentName, 'requires a retained Agent');
  test.setTimeout(60_000);
  await login(page);
  const events = await page.evaluate(
    async ({ projectId, agentName }) => {
      const { runClient } = await import('/src/api/client.ts');
      const startedAt = performance.now();
      const observed: Array<{ type: number; chunk: string; elapsedMs: number }> = [];
      for await (const event of runClient.streamAgentRun({
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
      agentName: retainedAgentName,
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

test('streams a shell run against the current backend model', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await ensureWebhookAcceptanceAgent(page);
  const response = await page.request.get('/api/ui/v1/projects');
  const body = (await response.json()) as {
    projects: Array<{ projectId: string; agents: Array<{ agentName: string }> }>;
  };
  const target = body.projects
    .flatMap((project) => project.agents.map((agent) => ({ projectId: project.projectId, agentName: agent.agentName })))
    .find((agent) => agent.agentName === 'ui-webhook-regression-agent');
  test.skip(!target, 'No Agent is available');

  const events = await page.evaluate(async ({ projectId, agentName }) => {
    const { runClient } = await import('/src/api/client.ts');
    const observed: Array<{
      type: number;
      chunk: string;
      runId: string;
      warnings: string[];
      status: number;
      stopReason: string;
    }> = [];
    for await (const event of runClient.streamAgentRun({
      projectId,
      agentName,
      source: 1,
      cleanupPolicy: 3,
      command: "printf 'BACKEND_V2_STREAM_1\\n'; sleep 1; printf 'BACKEND_V2_STREAM_2\\n'",
    })) {
      observed.push({
        type: event.eventType,
        chunk: event.chunk,
        runId: event.runId,
        warnings: event.warnings,
        status: event.run?.status ?? 0,
        stopReason: event.run?.stopReason ?? '',
      });
    }
    return observed;
  }, target!);

  expect(events[0]?.type, JSON.stringify(events)).toBe(1);
  expect(
    events
      .filter((event) => event.type === 2)
      .map((event) => event.chunk)
      .join(''),
  ).toContain('BACKEND_V2_STREAM_1\nBACKEND_V2_STREAM_2');
  expect(events.some((event) => event.type === 4)).toBe(true);
});

test('projects a configured Skill into a real Agent sandbox', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const response = await page.request.get('/api/ui/v1/projects');
  const body = (await response.json()) as {
    projects: Array<{ projectId: string; name: string; agents: Array<{ agentName: string }> }>;
  };
  const project = body.projects.find((item) => item.name === 'ui-agents');
  const agent = project?.agents.find((item) => item.agentName === 'llm-shell-regression-agent');
  test.skip(!project || !agent, 'The Skill acceptance Agent is not available');

  const events = await page.evaluate(
    async ({ projectId, agentName }) => {
      const { runClient } = await import('/src/api/client.ts');
      const observed: Array<{ type: number; chunk: string; status: number; error: string }> = [];
      for await (const event of runClient.streamAgentRun({
        projectId,
        agentName,
        source: 1,
        cleanupPolicy: 3,
        command: "test -f /root/.agents/skills/octobus-service-package/SKILL.md && printf 'SKILL_PROJECTED_OK\\n'",
      })) {
        observed.push({
          type: event.eventType,
          chunk: event.chunk,
          status: event.run?.status ?? 0,
          error: event.run?.error ?? '',
        });
      }
      return observed;
    },
    { projectId: project!.projectId, agentName: agent!.agentName },
  );

  expect(events.map((event) => event.chunk).join(''), JSON.stringify(events)).toContain('SKILL_PROJECTED_OK');
  expect(events.at(-1)?.status, JSON.stringify(events)).toBe(3);
});

test('runs an LLM turn against the current backend model', async ({ page }) => {
  test.skip(process.env.AGENT_COMPOSE_E2E_REAL_LLM !== '1', 'requires explicit authorization for real LLM calls');
  test.setTimeout(300_000);
  await login(page);
  await ensureWebhookAcceptanceAgent(page);
  const response = await page.request.get('/api/ui/v1/projects');
  const body = (await response.json()) as {
    projects: Array<{ projectId: string; agents: Array<{ agentName: string }> }>;
  };
  const target = body.projects
    .flatMap((project) => project.agents.map((agent) => ({ projectId: project.projectId, agentName: agent.agentName })))
    .find((agent) => agent.agentName === 'ui-webhook-regression-agent');
  test.skip(!target, 'No Agent is available');

  const result = await page.evaluate(async ({ projectId, agentName }) => {
    const { runClient } = await import('/src/api/client.ts');
    const { refreshSandboxHistoryCells } = await import('/src/api/sessions.ts');
    const observed: Array<{
      type: number;
      chunk: string;
      transcript: string;
      status: number;
      error: string;
    }> = [];
    let sandboxId = '';
    for await (const event of runClient.streamAgentRun({
      projectId,
      agentName,
      source: 1,
      cleanupPolicy: 1,
      prompt: 'Reply with exactly BACKEND_V2_LLM_OK and nothing else.',
    })) {
      sandboxId ||= event.sandboxId || event.run?.sandboxId || '';
      observed.push({
        type: event.eventType,
        chunk: event.chunk,
        transcript: event.transcript?.text ?? '',
        status: event.run?.status ?? 0,
        error: event.run?.error ?? '',
      });
    }
    const history = sandboxId ? await refreshSandboxHistoryCells(sandboxId) : [];
    return { observed, sandboxId, historyOutput: history.map((cell) => cell.output).join('\n') };
  }, target!);

  const events = result.observed;
  expect(events.map((event) => `${event.chunk}\n${event.transcript}`).join('\n'), JSON.stringify(events)).toContain(
    'BACKEND_V2_LLM_OK',
  );
  expect(events.at(-1)?.status, JSON.stringify(events)).toBe(3);
  expect(result.sandboxId).not.toBe('');
  expect(result.historyOutput).toContain('BACKEND_V2_LLM_OK');
});

test('calls the configured OctoBus MCP through a real Agent', async ({ page }) => {
  test.skip(process.env.AGENT_COMPOSE_E2E_REAL_LLM !== '1', 'requires explicit authorization for real LLM calls');
  test.setTimeout(300_000);
  await login(page);
  await ensureWebhookAcceptanceAgent(page);
  const configuredTarget = await page.evaluate(async () => {
    const { listSpecResourceTargets, saveSpecResource } = await import('/src/api/resources.ts');
    const target = (await listSpecResourceTargets('mcp')).find(
      (item) => item.projectName === 'ui-agents' && item.agentName === 'ui-webhook-regression-agent',
    );
    if (!target) throw new Error('The Agent MCP target is not available');
    await saveSpecResource(
      'mcp',
      target,
      '',
      JSON.stringify({
        name: 'ui-agent-calculator',
        type: 'remote',
        transport: 'http',
        url: 'http://172.17.0.1:9000/capsets/ui-mcp-regression/mcp',
      }),
    );
    return target;
  });
  const configuredProjectResponse = await page.request.post('/agentcompose.v2.ProjectService/GetProject', {
    data: { project: { projectId: configuredTarget.projectId }, includeSpec: true },
  });
  expect(configuredProjectResponse.ok(), await configuredProjectResponse.text()).toBeTruthy();
  const configuredProject = (await configuredProjectResponse.json()) as {
    project?: { spec?: { agents?: Array<{ name?: string; mcpServers?: Array<{ name?: string }> }> } };
  };
  const configuredAgent = configuredProject.project?.spec?.agents?.find(
    (agent) => agent.name === configuredTarget.agentName,
  );
  expect(configuredAgent?.mcpServers?.map((server) => server.name)).toContain('ui-agent-calculator');
  const response = await page.request.get('/api/ui/v1/projects');
  const body = (await response.json()) as {
    projects: Array<{ projectId: string; agents: Array<{ agentName: string }> }>;
  };
  const target = body.projects
    .flatMap((project) => project.agents.map((agent) => ({ projectId: project.projectId, agentName: agent.agentName })))
    .find((agent) => agent.agentName === 'ui-webhook-regression-agent');
  test.skip(!target, 'The MCP acceptance Agent is not available');

  const result = await page.evaluate(async ({ projectId, agentName }) => {
    const { runClient } = await import('/src/api/client.ts');
    let output = '';
    let error = '';
    let status = 0;
    let sandboxId = '';
    for await (const event of runClient.streamAgentRun({
      projectId,
      agentName,
      source: 1,
      cleanupPolicy: 2,
      prompt:
        'Use the configured calculator MCP tool to add 19 and 23. Do not calculate it yourself. After the tool returns 42, reply with exactly MCP_AGENT_RESULT_42.',
    })) {
      output += event.chunk;
      error = event.run?.error ?? error;
      status = event.run?.status ?? status;
      sandboxId ||= event.run?.sandboxId || event.sandboxId;
    }
    return { output, error, status, sandboxId };
  }, target!);

  expect(result.output, result.error).toContain('MCP_AGENT_RESULT_42');
  expect(result.status, result.error).toBe(3);
  expect(result.sandboxId).toBeTruthy();
  const recordsResponse = await page.request.get(`/api/ui/v1/sandboxes/${result.sandboxId}/agent-records`);
  const records = (await recordsResponse.json()) as { items: Array<{ id: string; provider: string }> };
  const codexRecords = records.items.filter((record) => record.provider === 'codex');
  expect(codexRecords.length).toBeGreaterThan(0);
  const recordContents = await Promise.all(
    codexRecords.map(async (record) => {
      const recordResponse = await page.request.get(
        `/api/ui/v1/sandboxes/${result.sandboxId}/agent-records/${encodeURIComponent(record.id)}`,
      );
      return ((await recordResponse.json()) as { content: string }).content;
    }),
  );
  expect(recordContents.join('\n')).toMatch(/mcp_tool_call|ui-calculator|calculator__ui-calculator__add/);
});

test('keeps a deterministic StreamAgentRun visible across navigation', async ({ page }) => {
  test.skip(!retainedProjectId || !retainedAgentName, 'requires a retained Agent');
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
              "printf 'UI_STREAM_CHUNK_1\\n'; sleep 3; printf 'UI_STREAM_CHUNK_2\\n'; sleep 3; printf 'UI_STREAM_CHUNK_3\\n'; sleep 3",
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
  const liveStream = page
    .locator('[data-conversation-turn]')
    .filter({ hasText: 'Deterministic UI stream regression' })
    .last();
  await expect(liveStream.getByText('UI_STREAM_CHUNK_1', { exact: false })).toBeVisible();
  await expect(liveStream.getByText('UI_STREAM_CHUNK_3', { exact: false })).toHaveCount(0);
  await expect(liveStream.getByText('回复中…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消本轮', exact: true })).toBeVisible();
  await expect(liveStream.getByText('UI_STREAM_CHUNK_2', { exact: false })).toBeVisible({ timeout: 6_000 });
  await expect(liveStream.getByText('UI_STREAM_CHUNK_3', { exact: false })).toBeVisible({ timeout: 6_000 });
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

test('refreshes an externally started run detail until completion', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  await ensureWebhookAcceptanceAgent(page);
  const response = await page.request.get('/api/ui/v1/projects');
  const body = (await response.json()) as {
    projects: Array<{ projectId: string; agents: Array<{ agentName: string }> }>;
  };
  const target = body.projects
    .flatMap((project) => project.agents.map((agent) => ({ projectId: project.projectId, agentName: agent.agentName })))
    .find((agent) => agent.agentName === 'ui-webhook-regression-agent');
  test.skip(!target, 'No Agent is available');

  await page.evaluate(async ({ projectId, agentName }) => {
    const { runClient } = await import('/src/api/client.ts');
    const testWindow = window as Window & { __externalRunId?: string; __externalSandboxId?: string };
    void (async () => {
      for await (const event of runClient.streamAgentRun({
        projectId,
        agentName,
        source: 1,
        cleanupPolicy: 2,
        command: "sleep 5; printf 'RUN_DETAIL_POLL_OK\\n'",
      })) {
        testWindow.__externalRunId ||= event.runId;
        testWindow.__externalSandboxId ||= event.run?.sandboxId;
      }
    })();
  }, target!);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const testWindow = window as Window & { __externalRunId?: string };
        return testWindow.__externalRunId ?? '';
      }),
    )
    .not.toBe('');
  const externalRunId = await page.evaluate(() => {
    const testWindow = window as Window & { __externalRunId?: string };
    return testWindow.__externalRunId ?? '';
  });
  expect(externalRunId).not.toBe('');
  try {
    await navigateInApp(page, `/runs/${externalRunId}`);
    await expect(page.locator('[data-semantic-status="running"]').first()).toBeVisible();
    await expect(page.locator('[data-semantic-status="success"]').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: '执行过程' }).click();
    await expect(page.locator('[data-run-execution-process]')).toContainText('RUN_DETAIL_POLL_OK');
  } finally {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const testWindow = window as Window & { __externalSandboxId?: string };
          return testWindow.__externalSandboxId ?? '';
        }),
      )
      .not.toBe('');
    const sandboxId = await page.evaluate(() => {
      const testWindow = window as Window & { __externalSandboxId?: string };
      return testWindow.__externalSandboxId ?? '';
    });
    await page.evaluate(async (id) => {
      const { sandboxClient } = await import('/src/api/client.ts');
      await sandboxClient.removeSandbox({ sandboxId: id, force: true });
    }, sandboxId);
  }
});

test('groups semantic runs into one execution-environment conversation', async ({ page }) => {
  test.skip(!retainedSandboxId, 'requires a retained execution environment');
  await login(page);
  await navigateInApp(page, `/sandboxes/${retainedSandboxId}`);
  await expect(page.getByRole('heading', { name: '执行环境' })).toBeVisible();
  await expect(page.getByRole('navigation').first().getByText('对话记录', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制 执行环境 ID' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '对话', exact: true })).toHaveAttribute('data-state', 'active');
  await expect(page.locator('[data-conversation-run]').first()).toBeVisible();
  await expect(
    page.locator('[data-conversation-run]').first().getByRole('button', { name: '复制 运行 ID' }),
  ).toBeVisible();
  await expect(page.locator('[data-message-role="user"]').first()).toBeVisible();
  await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible();
  await expect(page.getByPlaceholder('搜索当前对话')).toBeVisible();
  await expect(page.getByPlaceholder('输入消息，Shift + Enter 换行')).toBeVisible();
  await expect(page.getByText(/选择运行|查看运行/)).toHaveCount(0);
  await expect(page.getByText(/查看完整日志|收起完整日志/)).toHaveCount(0);
  await expect(page.getByText('执行过程', { exact: true })).toHaveCount(0);

  const runCount = await page.evaluate(async (sandboxId) => {
    const { listRuns } = await import('/src/api/runs.ts');
    return (await listRuns({ sandboxId, limit: 200 })).length;
  }, retainedSandboxId);
  await page.getByRole('tab', { name: '运行日志', exact: true }).click();
  const logPanel = page.getByRole('tabpanel', { name: '运行日志' });
  const logStream = logPanel.locator('[data-sandbox-log-stream] pre');
  await expect(logStream).toBeVisible();
  await expect
    .poll(async () => ((await logStream.innerText()).match(/^──── /gm) ?? []).length, { timeout: 10_000 })
    .toBe(runCount);
  await expect(logStream).not.toContainText('正在加载日志…', { timeout: 10_000 });
  await expect(logPanel.getByPlaceholder('筛选日志')).toBeVisible();
  await expect(logPanel.getByRole('button', { name: '下载原始日志' })).toBeVisible();
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await expect(page.locator('[data-message-role="user"]').first()).toBeVisible();
});

test('browses Codex and Claude JSONL records from the sandbox data root', async ({ page }) => {
  test.skip(!retainedSandboxId, 'requires a retained execution environment with acceptance JSONL records');
  await login(page);
  await navigateInApp(page, `/sandboxes/${retainedSandboxId}`);
  await page.getByRole('tab', { name: '智能体记录', exact: true }).click();

  const records = page.locator('[data-agent-records]');
  const selector = records.getByLabel('选择智能体记录');
  await expect(selector).toBeEnabled();
  await selector.selectOption({ label: 'Codex · ui-acceptance.jsonl' });
  await expect(records.locator('[data-agent-record-events]')).toContainText('CODEX_RECORD_SEARCH_MARKER');
  await records.getByPlaceholder('搜索智能体记录').fill('CODEX_RECORD_SEARCH_MARKER');
  await expect(records.getByText('1 条事件', { exact: true })).toBeVisible();
  await records.getByRole('button', { name: '原文', exact: true }).click();
  await expect(records.locator('[data-agent-record-content]')).toContainText('CODEX_RECORD_SEARCH_MARKER');
  const codexDownload = page.waitForEvent('download');
  await records.getByRole('button', { name: '下载', exact: true }).click();
  expect((await codexDownload).suggestedFilename()).toBe('ui-acceptance.jsonl');

  await selector.selectOption({ label: 'Claude · ui-acceptance.jsonl' });
  await expect(records.locator('[data-agent-record-events]')).toContainText('CLAUDE_RECORD_SEARCH_MARKER');
  await records.getByPlaceholder('搜索智能体记录').fill('CLAUDE_RECORD_SEARCH_MARKER');
  await expect(records.getByText('1 条事件', { exact: true })).toBeVisible();
  await records.getByRole('button', { name: '原文', exact: true }).click();
  await expect(records.locator('[data-agent-record-content]')).toContainText('CLAUDE_RECORD_SEARCH_MARKER');
});

test('shows recovery only for stopped execution environments', async ({ page }) => {
  await login(page);
  const sandboxIds = await page.evaluate(async () => {
    const { listSandboxContexts } = await import('/src/api/sessions.ts');
    const response = await listSandboxContexts(200);
    const stopped = response.sessions.find((sandbox) => sandbox.status.trim().toLowerCase() === 'stopped');
    return {
      stopped: stopped?.id ?? '',
      stoppedRuntimePolicy: stopped?.stoppedRuntimePolicy ?? '',
      stoppedRuntimeState: stopped?.stoppedRuntimeState ?? '',
      failed: response.sessions.find((sandbox) => sandbox.status.trim().toLowerCase() === 'failed')?.id ?? '',
    };
  });
  test.skip(!sandboxIds.stopped, 'No stopped execution environment is available');

  await navigateInApp(page, `/sandboxes/${sandboxIds.stopped}`);
  const recoveryButton = page.getByRole('button', { name: '恢复', exact: true });
  await expect(recoveryButton).toBeVisible();
  await expect(page.locator('[data-sandbox-actions]').getByRole('button', { name: '恢复', exact: true })).toBeVisible();
  const [headingBox, recoveryBox] = await Promise.all([
    page.locator('[data-sandbox-workbench] h2').boundingBox(),
    recoveryButton.boundingBox(),
  ]);
  expect(recoveryBox!.x).toBeGreaterThan(headingBox!.x);
  expect(Math.abs(recoveryBox!.y - headingBox!.y)).toBeLessThan(32);
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-composer]')).toHaveCount(0);
  if (sandboxIds.stoppedRuntimeState || sandboxIds.stoppedRuntimePolicy === 'retain') {
    await expect(page.locator('[data-stopped-runtime-state]')).toBeVisible();
  }

  if (sandboxIds.failed) {
    await navigateInApp(page, `/sandboxes/${sandboxIds.failed}`);
    await expect(page.getByRole('button', { name: '恢复', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '终端', exact: true })).toHaveCount(0);
  }
});

test('resumes and releases a stopped execution environment', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  const sandboxId = await page.evaluate(async () => {
    const { listSandboxContexts } = await import('/src/api/sessions.ts');
    const response = await listSandboxContexts(200);
    return (
      response.sessions.find(
        (sandbox) =>
          sandbox.status.trim().toLowerCase() === 'stopped' &&
          sandbox.stoppedRuntimePolicy === 'remove' &&
          sandbox.stoppedRuntimeState === 'released',
      )?.id ?? ''
    );
  });
  test.skip(!sandboxId, 'No released execution environment is available');

  await navigateInApp(page, `/sandboxes/${sandboxId}`);
  const workbench = page.locator('[data-sandbox-workbench]');
  await expect(workbench.locator('[data-stopped-runtime-state]')).toContainText('运行环境已释放');
  await workbench.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(workbench.getByRole('button', { name: '停止', exact: true })).toBeVisible({ timeout: 30_000 });
  await workbench.getByRole('button', { name: '停止', exact: true }).click();
  await expect(workbench.getByRole('button', { name: '恢复', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(workbench.locator('[data-stopped-runtime-state]')).toContainText('运行环境已释放');
});

test('separates user and agent messages without mobile overflow', async ({ page }) => {
  test.skip(!retainedSandboxId, 'requires a retained execution environment');
  await login(page);
  await navigateInApp(page, `/sandboxes/${retainedSandboxId}`);
  const userMessage = page.locator('[data-message-role="user"]').first();
  const agentMessage = page.locator('[data-message-role="assistant"]').first();
  await expect(userMessage).toBeVisible();
  await expect(agentMessage).toBeVisible();

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const [userBox, agentBox] = await Promise.all([userMessage.boundingBox(), agentMessage.boundingBox()]);
    expect(userBox).not.toBeNull();
    expect(agentBox).not.toBeNull();
    expect(userBox!.x).toBeGreaterThan(agentBox!.x);
    expect(userBox!.width).toBeLessThanOrEqual(viewport.width * 0.92 + 1);
    expect(agentBox!.width).toBeLessThanOrEqual(viewport.width * 0.92 + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
  }
});

test('shows conversation send feedback before a stream request finishes', async ({ page }) => {
  test.skip(!retainedSandboxId, 'requires a retained running conversation');
  test.setTimeout(60_000);
  const prompt = `UI_PENDING_MESSAGE_${Date.now()}`;
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
  });
  await login(page);

  try {
    await page.route('**/agentcompose.v2.RunService/StreamAgentRun', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.abort('failed');
    });
    await navigateInApp(page, `/sandboxes/${retainedSandboxId}`);
    await page.getByRole('tab', { name: '对话', exact: true }).click();
    const composer = page.locator('[data-composer]');
    await expect(composer).toBeVisible();
    await composer.getByPlaceholder('输入消息，Shift + Enter 换行').fill(prompt);
    await composer.getByRole('button', { name: '发送', exact: true }).click();

    const pending = page.locator('[aria-live="polite"]').filter({ hasText: prompt });
    await expect(pending).toBeVisible();
    await expect(pending).toContainText('正在发送…');
    await expect(composer.getByRole('button', { name: '取消本轮' })).toBeEnabled();
    const failedTurn = page.locator('[data-conversation-run][data-status="failed"]').filter({ hasText: prompt });
    await expect(failedTurn).toBeVisible({ timeout: 5_000 });
    await expect(failedTurn).toContainText(/失败|fetch|网络|请求/i);
    await expect(page.locator('[data-page-error]')).toHaveCount(0);
  } finally {
    await page.unroute('**/agentcompose.v2.RunService/StreamAgentRun');
  }
});

test('keeps automations under their Project and prioritizes enabled tasks', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const projectResponse = await page.request.get('/api/ui/v1/projects');
  const projectBody = (await projectResponse.json()) as {
    projects: Array<{ projectId: string; name: string; agents: Array<{ displayName: string }> }>;
  };
  const project = projectBody.projects.find((item) => item.agents.length > 0);
  test.skip(!project, 'No Project with Agents is available');
  await expect(page.getByRole('navigation').getByRole('button', { name: '自动化', exact: true })).toHaveCount(0);
  await navigateInApp(page, '/projects');
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
  await page.locator('aside').getByText(project!.name, { exact: true }).click();
  await expect(page.getByText(project!.agents[0].displayName, { exact: true })).toBeVisible();
  await page.getByPlaceholder('搜索项目或智能体…').fill('__no_matching_project__');
  await expect(page.getByText('没有匹配的项目')).toBeVisible();

  await navigateInApp(page, `/projects/${encodeURIComponent(project!.projectId)}/automations`);
  await expect(page).toHaveURL(new RegExp(`/projects/${project!.projectId}/automations`));
  const automationFilters = page.getByLabel('自动化状态筛选');
  await expect(automationFilters.getByRole('button', { name: /已启用 \d+/, pressed: true })).toBeVisible();
  const automationRows = page.locator('tbody tr').filter({ has: page.getByText('已启用', { exact: true }) });
  const enabledTaskCount = await automationRows.count();
  for (let index = 0; index < enabledTaskCount; index += 1) {
    await expect(automationRows.nth(index)).toContainText('已启用');
  }
  await page.getByPlaceholder('搜索项目、智能体、自动化或 ID').fill('__no_matching_automation__');
  await expect(page.getByRole('cell', { name: /没有匹配的自动化|还没有自动化/ })).toBeVisible();
});

test('previews Agent automation as a Project deployment without applying it', async ({ page }) => {
  await login(page);
  const response = await page.request.get('/api/ui/v1/projects');
  const body = (await response.json()) as {
    projects: Array<{
      projectId: string;
      currentRevision: string;
      editable: boolean;
      agents: Array<{ agentName: string; hasScheduler: boolean }>;
    }>;
  };
  const target = body.projects
    .filter((project) => project.editable)
    .flatMap((project) => project.agents.map((agent) => ({ project, agent })))
    .find(({ agent }) => !agent.hasScheduler);
  test.skip(!target, 'No editable Agent without automation is available');

  await navigateInApp(
    page,
    `/projects/${encodeURIComponent(target!.project.projectId)}/automations/new?agent=${encodeURIComponent(target!.agent.agentName)}`,
  );
  await expect(page.getByLabel('所属项目 / 智能体')).not.toHaveValue('');
  await page.getByLabel('名称').fill('Preview only automation');
  await page.getByRole('button', { name: '添加变量' }).click();
  await page.getByLabel('环境变量名称').fill('UI_PREVIEW_ONLY');
  await page.getByLabel('环境变量值').fill('not-applied');
  await setMonacoValue(
    page,
    `scheduler.on('ui.preview.only', 'preview-only', function previewOnly() { return { ok: true }; });`,
  );
  await page.getByRole('button', { name: '预览部署', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/^自动化配置 ·/)).toBeVisible();
  await expect(dialog.getByText(/^智能体配置 ·/)).toBeVisible();
  await expect(dialog.getByText(/project_scheduler/)).not.toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认部署项目' })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消' }).click();

  const refreshed = (await (await page.request.get('/api/ui/v1/projects')).json()) as typeof body;
  expect(refreshed.projects.find((project) => project.projectId === target!.project.projectId)?.currentRevision).toBe(
    target!.project.currentRevision,
  );
});

test('previews project environment variables without applying them', async ({ page }) => {
  await login(page);
  const response = await page.request.get('/api/ui/v1/projects');
  const body = (await response.json()) as {
    projects: Array<{
      projectId: string;
      currentRevision: string;
      editable: boolean;
      variables: Array<{ name: string }>;
    }>;
  };
  const target = body.projects.find((project) => project.editable);
  test.skip(!target, 'No editable Project is available');

  await navigateInApp(page, `/projects/${encodeURIComponent(target!.projectId)}`);
  await page.getByRole('button', { name: /项目变量/ }).click();
  await expect(page.getByRole('heading', { name: '项目环境变量', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: '添加变量' }).click();
  await page.getByLabel('环境变量名称').last().fill(`UI_PREVIEW_${Date.now()}`);
  await page.getByLabel('环境变量值').last().fill('not-applied');
  await page.getByRole('button', { name: '预览部署', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('项目', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认部署项目' })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消' }).click();

  const refreshed = (await (await page.request.get('/api/ui/v1/projects')).json()) as typeof body;
  const unchanged = refreshed.projects.find((project) => project.projectId === target!.projectId);
  expect(unchanged?.currentRevision).toBe(target!.currentRevision);
  expect(unchanged?.variables).toEqual(target!.variables);
});

test('previews agent environment variables without applying them', async ({ page }) => {
  await login(page);
  const response = await page.request.get('/api/ui/v1/projects');
  const body = (await response.json()) as {
    projects: Array<{
      projectId: string;
      currentRevision: string;
      editable: boolean;
      agents: Array<{ agentName: string }>;
    }>;
  };
  const target = body.projects
    .filter((project) => project.editable)
    .flatMap((project) => project.agents.map((agent) => ({ project, agent })))
    .at(0);
  test.skip(!target, 'No editable Agent is available');

  await navigateInApp(
    page,
    `/projects/${encodeURIComponent(target!.project.projectId)}/agents/${encodeURIComponent(target!.agent.agentName)}/edit`,
  );
  for (const heading of ['基本信息', '模型配置', '执行环境', '能力与变量']) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.getByText('智能体环境变量', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加变量' }).click();
  await page.getByLabel('环境变量名称').last().fill(`UI_AGENT_PREVIEW_${Date.now()}`);
  await page.getByLabel('环境变量值').last().fill('not-applied');
  await page.getByRole('button', { name: '预览部署', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('智能体配置', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认部署项目' })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消' }).click();

  const refreshed = (await (await page.request.get('/api/ui/v1/projects')).json()) as typeof body;
  expect(refreshed.projects.find((project) => project.projectId === target!.project.projectId)?.currentRevision).toBe(
    target!.project.currentRevision,
  );
});

test('keeps the automation editor usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const response = await page.request.get('/api/ui/v1/projects');
  const body = (await response.json()) as {
    projects: Array<{
      projectId: string;
      editable: boolean;
      agents: Array<{ agentName: string; hasScheduler: boolean }>;
    }>;
  };
  const target = body.projects
    .filter((project) => project.editable)
    .flatMap((project) => project.agents.map((agent) => ({ project, agent })))
    .find(({ agent }) => !agent.hasScheduler);
  test.skip(!target, 'No editable Agent without automation is available');

  await navigateInApp(
    page,
    `/projects/${encodeURIComponent(target!.project.projectId)}/automations/new?agent=${encodeURIComponent(target!.agent.agentName)}`,
  );
  await expect(page.getByLabel('所属项目 / 智能体')).not.toHaveValue('');
  await expect(page.getByRole('heading', { name: '基本信息', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '执行策略', exact: true })).toBeVisible();
  await expect(page.getByText('所属智能体环境变量', { exact: true })).toBeVisible();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.getByRole('button', { name: '添加变量' }).click();
  await expect(page.getByLabel('环境变量值')).toBeVisible();

  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1);

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toBe('放弃未保存的更改？');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(/\/automations\/new/);
});

test('fills the owning Project and Agent when editing automation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.evaluate(() => localStorage.removeItem('ac.automationConfigPaneWidth'));
  const projects = (await (await page.request.get('/api/ui/v1/projects')).json()) as {
    projects: Array<{ projectId: string; name: string }>;
  };
  const project = projects.projects.find((item) => item.name === 'ui-agents');
  test.skip(!project, 'ui-agents Project is unavailable');
  await navigateInApp(page, `/projects/${encodeURIComponent(project!.projectId)}/automations`);
  const row = page.locator('tbody tr').filter({ hasText: 'UI Agent Shell Regression' });
  await row.getByRole('button', { name: '编辑' }).click();
  const owner = page.getByLabel('所属项目 / 智能体');
  await expect(owner).not.toHaveValue('');
  await expect(owner.locator('option:checked')).toContainText('LLM Shell Regression Agent');

  const pane = page.locator('section[data-scroll-pane]');
  const handle = page.getByRole('button', { name: '调整配置栏宽度' });
  const initialWidth = await pane.evaluate((element) => element.getBoundingClientRect().width);
  const handleBounds = await handle.boundingBox();
  expect(handleBounds).toBeTruthy();
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + handleBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2 + 160, handleBounds!.y + handleBounds!.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(() => pane.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(initialWidth + 120);

  await page.getByRole('button', { name: '添加变量' }).click();
  const valueWidth = await page
    .getByLabel('环境变量值')
    .last()
    .evaluate((element) => element.getBoundingClientRect().width);
  const resizedWidth = await pane.evaluate((element) => element.getBoundingClientRect().width);
  expect(valueWidth).toBeGreaterThan(resizedWidth * 0.75);
});

test('creates and navigates a two-agent project through deployment previews', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await navigateInApp(page, '/projects');
  const projectName = 'ui-project-workbench-regression';

  if ((await page.getByText(projectName, { exact: true }).count()) === 0) {
    await page.getByRole('button', { name: '新建项目' }).first().click();
    await page.getByLabel('项目名称').fill(projectName);
    await page.getByLabel('调用标识').fill('primary-agent');
    await page.getByLabel('显示名称').fill('Primary Project Agent');
    await page.getByRole('textbox', { name: '模型', exact: true }).fill(e2eModel);
    await page.getByRole('button', { name: '预览部署' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('primary-agent', { exact: true }).first()).toBeVisible();
    await dialog.getByRole('button', { name: '确认部署项目' }).click();
    await expect(page.getByRole('heading', { name: 'Primary Project Agent' })).toBeVisible();
  }

  await navigateInApp(page, '/projects');
  await page.locator('aside').getByText(projectName, { exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  const projectPath = new URL(page.url()).pathname;
  if ((await page.getByText('Secondary Project Agent', { exact: true }).count()) === 0) {
    await page.getByRole('button', { name: '新增智能体' }).click();
    await page.getByLabel('调用标识').fill('secondary-agent');
    await page.getByLabel('显示名称').fill('Secondary Project Agent');
    await page.getByRole('textbox', { name: '模型', exact: true }).fill(e2eModel);
    await page.getByRole('button', { name: '预览部署' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('div.rounded-md.border')).toHaveCount(1);
    await expect(dialog.getByText('secondary-agent', { exact: true })).toBeVisible();
    await expect(dialog.getByText('project_scheduler')).toHaveCount(0);
    await dialog.getByRole('button', { name: '确认部署项目' }).click();
  }

  await navigateInApp(page, projectPath);
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  await expect(page.getByText('Primary Project Agent', { exact: true })).toBeVisible();
  await expect(page.getByText('Secondary Project Agent', { exact: true })).toBeVisible();
  await expect(page.getByText('2', { exact: true }).first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await navigateInApp(page, '/projects');
  await expect(page).toHaveURL(/\/projects$/);
  await page.locator('aside').getByText(projectName, { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByText('Primary Project Agent', { exact: true })).toBeVisible();
});

test('preserves an agent scheduler when deploying an agent edit and redirects legacy links', async ({ page }) => {
  await login(page);
  const projectResponse = await page.request.get('/api/ui/v1/projects');
  const body = (await projectResponse.json()) as {
    projects: Array<{
      projectId: string;
      agents: Array<{
        id: string;
        agentName: string;
        displayName: string;
        hasScheduler: boolean;
        stoppedRuntimePolicy: string;
      }>;
    }>;
  };
  const linked = body.projects
    .flatMap((project) => project.agents.map((agent) => ({ project, agent })))
    .find(({ agent }) => agent.hasScheduler);
  expect(linked).toBeTruthy();

  await page.evaluate((target) => {
    history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/agents/${linked!.agent.id}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${linked!.project.projectId}/agents/${linked!.agent.agentName}$`));
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByLabel('停止后')).toHaveValue(linked!.agent.stoppedRuntimePolicy || 'remove');
  const previewName = `${linked!.agent.displayName} Preview`;
  try {
    await page.getByLabel('显示名称').fill(previewName);
    await page.getByRole('button', { name: '预览部署' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('div.rounded-md.border')).toHaveCount(1);
    await expect(dialog.getByText('project_scheduler')).toHaveCount(0);
    await dialog.getByRole('button', { name: '确认部署项目' }).click();
    await expect(page.getByRole('heading', { name: previewName })).toBeVisible();

    const refreshed = (await (await page.request.get('/api/ui/v1/projects')).json()) as typeof body;
    const changed = refreshed.projects
      .flatMap((project) => project.agents)
      .find((agent) => agent.id === linked!.agent.id);
    expect(changed?.displayName).toBe(previewName);
    expect(changed?.hasScheduler).toBe(true);
    expect(changed?.stoppedRuntimePolicy).toBe(linked!.agent.stoppedRuntimePolicy || 'remove');
  } finally {
    const current = (await (await page.request.get('/api/ui/v1/projects')).json()) as typeof body;
    const changed = current.projects
      .flatMap((project) => project.agents)
      .find((agent) => agent.id === linked!.agent.id);
    if (changed?.displayName === previewName) {
      await page.evaluate((target) => {
        history.pushState({}, '', target);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, `/projects/${linked!.project.projectId}/agents/${linked!.agent.agentName}`);
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByLabel('显示名称').fill(linked!.agent.displayName);
      await page.getByRole('button', { name: '预览部署' }).click();
      await page.getByRole('dialog').getByRole('button', { name: '确认部署项目' }).click();
      await expect
        .poll(async () => {
          const response = (await (await page.request.get('/api/ui/v1/projects')).json()) as typeof body;
          return response.projects.flatMap((project) => project.agents).find((agent) => agent.id === linked!.agent.id)
            ?.displayName;
        })
        .toBe(linked!.agent.displayName);
    }
  }

  const restored = (await (await page.request.get('/api/ui/v1/projects')).json()) as typeof body;
  const unchanged = restored.projects
    .flatMap((project) => project.agents)
    .find((agent) => agent.id === linked!.agent.id);
  expect(unchanged?.displayName).toBe(linked!.agent.displayName);
  expect(unchanged?.hasScheduler).toBe(true);
});

test('preserves a Cron timezone through an automation deployment', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const result = await page.evaluate(async () => {
    const { projectClient } = await import('/src/api/client.ts');
    const { getAutomationTask, listAutomationTasks, previewAutomationTask } = await import('/src/api/loaders.ts');
    const { projectSpecForUpdate } = await import('/src/api/project-spec.ts');
    const { applyProjectPreview, listProjectViews } = await import('/src/api/projects.ts');
    const { AgentSpec, ProjectSpec, SchedulerSpec, TriggerKind, TriggerSpec } =
      await import('/src/gen/agentcompose/v2/agentcompose_pb.ts');
    const projects = await listProjectViews();
    const tasks = (await Promise.all(projects.map((project) => listAutomationTasks(project.projectId)))).flat();
    const target = tasks.find((task) =>
      projects.some(
        (project) =>
          project.projectId === task.projectId &&
          project.editable &&
          project.agents.some(
            (agent) => agent.agentName === task.agentName && agent.image.includes('agent-compose-guest'),
          ),
      ),
    );
    if (!target) return { skipped: true, timezone: '' };

    const current = await projectClient.getProject({
      project: { selector: { case: 'projectId', value: target.projectId } },
      includeSpec: true,
    });
    if (!current.project?.spec) throw new Error('Cron timezone acceptance project is unavailable');
    const updateableSpec = projectSpecForUpdate(current.project.spec);
    const originalSpec = updateableSpec.toJson();
    const configured = new ProjectSpec({
      ...updateableSpec,
      agents: updateableSpec.agents.map((agent) =>
        agent.name === target.agentName
          ? new AgentSpec({
              ...agent,
              scheduler: new SchedulerSpec({
                ...agent.scheduler,
                script: '',
                triggers: [
                  new TriggerSpec({
                    name: 'ui-timezone-roundtrip',
                    kind: TriggerKind.CRON,
                    cron: '0 9 * * *',
                    timezone: 'Asia/Shanghai',
                  }),
                ],
              }),
            })
          : agent,
      ),
    });
    const prepared = await projectClient.applyProject({ spec: configured });
    if (!prepared.applied && !prepared.unchanged) {
      throw new Error(
        prepared.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n') ||
          'Unable to prepare Cron timezone acceptance data',
      );
    }

    let timezone = '';
    let operationError = '';
    try {
      const detail = await getAutomationTask(target.projectId, target.agentName);
      const preview = await previewAutomationTask(target.projectId, target.agentName, {
        ...detail,
        name: `${detail.name} Timezone Roundtrip`,
        triggers: detail.configuredTriggers,
      });
      if (!preview.deployable) throw new Error('Cron timezone roundtrip did not produce a deployment preview');
      await applyProjectPreview(preview.previewId);
      const saved = await projectClient.getScheduler({
        project: { selector: { case: 'projectId', value: target.projectId } },
        agentName: target.agentName,
      });
      timezone = saved.spec?.triggers[0]?.timezone ?? '';
    } catch (cause) {
      operationError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      const restored = await projectClient.applyProject({ spec: ProjectSpec.fromJson(originalSpec) });
      if (!restored.applied && !restored.unchanged)
        operationError ||= 'Cron timezone acceptance project was not restored';
    }
    if (operationError) throw new Error(operationError);
    return { skipped: false, timezone };
  });

  test.skip(result.skipped, 'No editable automation is available');
  expect(result.timezone).toBe('Asia/Shanghai');
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
  await expect(page.getByText('运行记录正在同步')).toHaveCount(0);
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

test('manages API tokens from the current user account', async ({ page }) => {
  await login(page);
  await navigateInApp(page, '/settings');
  await expect(page.getByRole('tab', { name: 'API 令牌' })).toHaveCount(0);
  await page.getByRole('button', { name: '管理个人 API 令牌' }).click();
  await expect(page).toHaveURL(/\/account\/tokens$/);
  await expect(page.getByRole('heading', { level: 1, name: 'API 令牌', exact: true })).toBeVisible();

  if (await page.getByText('API 令牌未启用').isVisible()) return;

  const name = `UI Regression Token ${Date.now()}`;
  await page.getByRole('button', { name: '创建令牌' }).click();
  await page.getByLabel('名称').fill(name);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'API 令牌已创建' })).toBeVisible();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '复制令牌' }).click();
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
  await page.getByLabel('操作或接口').fill('DELETE /api/ui/v1/tokens/' + created.id);
  await page.getByRole('button', { name: '查询', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: created.id.slice(0, 16) });
  await expect(row).toContainText('admin');
  await expect(row).toContainText('成功');
  await row.click();
  await expect(page.getByRole('heading', { name: '审计详情' })).toBeVisible();
  await page.getByText('请求详情', { exact: true }).click();
  await expect(page.getByText('local:admin', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();

  for (const format of ['JSON', 'CSV']) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: new RegExp(format) }).click();
    expect((await download).suggestedFilename()).toBe(`audit-events.${format.toLowerCase()}`);
  }
});

test('keeps audit wheel scrolling and resets the list after pagination', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await login(page);
  await page.route('**/api/ui/v1/audit/events?*', async (route) => {
    const secondPage = new URL(route.request().url()).searchParams.has('cursor');
    const count = secondPage ? 5 : 50;
    await route.fulfill({
      json: {
        items: Array.from({ length: count }, (_, index) => ({
          id: `${secondPage ? 'second' : 'first'}-${index}`,
          occurredAt: new Date(Date.now() - index * 1000).toISOString(),
          actor: {
            id: 'local:admin',
            source: 'local',
            username: 'admin',
            displayName: 'admin',
            authMethod: 'password',
          },
          category: 'project',
          action: `audit-scroll-${index}`,
          resourceType: 'project',
          resourceId: `resource-${index}`,
          method: 'POST',
          path: '/api/ui/v1/project-deployment-previews',
          outcome: 'success',
          status: 200,
          durationMs: index,
          requestId: `request-${index}`,
          remoteIp: '127.0.0.1',
          userAgent: 'playwright',
        })),
        nextCursor: secondPage ? '' : 'next-page',
        hasMore: !secondPage,
      },
    });
  });

  await navigateInApp(page, '/audit');
  const list = page.locator('[data-audit-list]');
  await list.locator('tbody tr').first().hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(300);

  await list.evaluate((element) => {
    element.scrollTop = 900;
    element.scrollLeft = 120;
  });
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByText('第 2 页 · 每页最多 50 条')).toBeVisible();
  await expect.poll(() => list.evaluate((element) => [element.scrollTop, element.scrollLeft])).toEqual([0, 0]);
});

test('does not rewrite projects with redacted project OctoBus credentials', async ({ page }) => {
  let applyProjectRequests = 0;

  await page.route('**/agentcompose.v2.ProjectService/GetProject', async (route) => {
    const response = await route.fetch();
    const framed = new Uint8Array(await response.body());
    const messageLength = new DataView(framed.buffer, framed.byteOffset + 1, 4).getUint32(0);
    const body = GetProjectResponse.fromBinary(framed.subarray(5, 5 + messageLength));
    if (body.project?.spec) {
      body.project.spec.octobusServers = [
        new OctoBusServerSpec({
          name: 'internal',
          endpoint: 'https://octobus.example',
          token: '********',
        }),
      ];
      body.project.spec.mcpServers = [
        new MCPServerSpec({
          name: 'ui-regression-mcp',
          type: 'remote',
          transport: 'http',
          url: 'http://octobus.example/capsets/e2e/mcp',
        }),
      ];
    }
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
  const resource = page.locator('article').filter({ hasText: 'ui-regression-mcp' }).first();
  await expect(resource).toBeVisible();
  await resource.getByRole('button', { name: '编辑' }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();

  await expect(page.getByText(/项目包含项目级 OctoBus 配置/)).toBeVisible();
  expect(applyProjectRequests).toBe(0);
  await expect(resource.getByText('ui-regression-mcp', { exact: true })).toBeVisible();
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
    await webhookPanel.getByPlaceholder('来源').fill('test');
    await webhookPanel.getByPlaceholder('事件主题前缀').fill('webhook.ui-regression.');
    await webhookPanel.getByPlaceholder('访问令牌（留空保持）').fill(webhookTestToken);
    await webhookPanel.getByRole('button', { name: '添加来源' }).click();
  } else {
    await webhookCard.getByRole('button', { name: '编辑' }).click();
    await webhookPanel.getByPlaceholder('事件主题前缀').fill('webhook.ui-regression.');
    await webhookPanel.getByPlaceholder('访问令牌（留空保持）').fill(webhookTestToken);
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
  const acceptedEvent = page.getByRole('table').getByTitle(acceptedWebhook.event_id);
  await expect(acceptedEvent).toBeVisible();
  await acceptedEvent.click();
  await expect(page.getByRole('heading', { name: 'Webhook 事件详情' })).toBeVisible();
  await expect(page.getByText('webhook.ui-regression.acceptance', { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/WEBHOOK_EVENT_DETAIL_OK/)).toHaveCount(0);
  await expect(page.getByText('Webhook Payload')).toHaveCount(0);

  await navigateInApp(page, '/settings');
  await page.getByRole('tab', { name: '工作目录' }).click();
  const workspacePanel = page.getByRole('tabpanel', { name: '工作目录' });
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
  await expect(page.getByText('工作目录预设已创建')).toBeVisible();

  await navigateInApp(page, '/projects');
  await page.locator('[data-page-frame] aside button').filter({ hasText: 'ui-agents' }).click();
  await expect(page.getByRole('button', { name: /LLM Shell Regression Agent/ })).toBeVisible();

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
      .filter({ hasText: /ui-agents.*LLM Shell Regression Agent/ })
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
      ref: '25badd7782e2df60cc1b09b37386acb4f0e879d3',
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

  await navigateInApp(page, '/projects');
  await page.locator('[data-page-frame] aside button').filter({ hasText: 'ui-agents' }).click();
  const regressionAgentName = 'Webhook 验收智能体';
  const regressionAgentButton = page.getByRole('button', { name: new RegExp(regressionAgentName) });
  await expect(regressionAgentButton)
    .toBeVisible({ timeout: 10_000 })
    .catch(() => undefined);
  if ((await regressionAgentButton.count()) === 0) {
    await page.getByRole('button', { name: '新增智能体' }).click();
    await page.getByLabel('调用标识').fill('ui-webhook-regression-agent');
    await page.getByLabel('显示名称').fill(regressionAgentName);
    await page.getByRole('textbox', { name: '模型', exact: true }).fill(e2eModel);
    await page.getByRole('button', { name: '预览部署' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认部署项目' }).click();
    await expect(page.getByRole('heading', { name: regressionAgentName })).toBeVisible({ timeout: 30_000 });
  } else {
    await regressionAgentButton.click();
  }
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('Guest 镜像').fill(e2eGuestImage);
  await page.getByRole('button', { name: '预览部署' }).click();
  const previewDialog = page.getByRole('dialog');
  if (await previewDialog.getByRole('button', { name: '确认部署项目' }).isEnabled()) {
    await previewDialog.getByRole('button', { name: '确认部署项目' }).click();
  } else {
    await previewDialog.getByRole('button', { name: '取消' }).click();
    await navigateInApp(page, '/projects');
    await page.getByText(regressionAgentName, { exact: true }).click();
  }
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
    await page.getByPlaceholder('输入消息，Shift + Enter 换行').fill(followupPrompt);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: followupPrompt })).toContainText(
      /正在发送|回复中/,
    );
    await expect(
      chatPanel.locator('[data-message-role="assistant"]').filter({ hasText: 'LLM_FOLLOWUP_OK' }).last(),
    ).toBeVisible({ timeout: 180_000 });
    await expect(page).toHaveURL(previousRunUrl);
    await expect(chatPanel.getByRole('button', { name: '查看运行', exact: true }).last()).toBeVisible();
  }

  const automationProjects = (await (await page.request.get('/api/ui/v1/projects')).json()) as {
    projects: Array<{ projectId: string; name: string }>;
  };
  const automationProject = automationProjects.projects.find((item) => item.name === 'ui-agents');
  expect(automationProject).toBeTruthy();
  const automationPath = `/projects/${encodeURIComponent(automationProject!.projectId)}/automations`;
  await navigateInApp(page, automationPath);
  await expect(page.getByRole('heading', { name: '自动化' })).toBeVisible();
  const taskName = webhookSchedulerDisplayName;
  const taskRow = page.locator('tbody tr:visible, article:visible').filter({ hasText: taskName });
  await expect(taskRow)
    .toBeVisible({ timeout: 10_000 })
    .catch(() => undefined);
  if ((await taskRow.count()) === 0) {
    await page.getByRole('button', { name: '配置自动化' }).click();
    await page.getByLabel('名称').fill(taskName);
    const owner = page.getByLabel('所属项目 / 智能体');
    const ownerValue = await owner.locator('option').filter({ hasText: regressionAgentName }).getAttribute('value');
    expect(ownerValue).toBeTruthy();
    await owner.selectOption(ownerValue!);
  } else {
    await taskRow.getByRole('button', { name: '编辑' }).click();
  }
  await page.getByLabel('描述').fill('Acceptance regression: automation invokes an agent that executes shell.');
  await setMonacoValue(page, webhookAutomationScript);
  await page.getByRole('button', { name: '预览部署', exact: true }).click();
  const deploymentDialog = page.getByRole('dialog');
  await expect(deploymentDialog.getByText('项目部署预览')).toBeVisible();
  const confirmDeployment = deploymentDialog.getByRole('button', { name: '确认部署项目' });
  if (await confirmDeployment.isEnabled()) await confirmDeployment.click();
  else {
    await deploymentDialog.getByRole('button', { name: '取消' }).click();
    await navigateInApp(page, automationPath);
  }
  await expect(taskRow).toBeVisible({ timeout: 30_000 });
  const resumedAutomationRunId = process.env.AGENT_COMPOSE_E2E_RESUME_AUTOMATION_RUN_ID;
  if (resumedAutomationRunId) {
    await navigateInApp(
      page,
      `/projects/${encodeURIComponent(automationProject!.projectId)}/automation-runs/${encodeURIComponent(resumedAutomationRunId)}`,
    );
  } else {
    await taskRow.getByRole('button', { name: '运行', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '开始运行' }).click();
    await expect(page).toHaveURL(/\/automation-runs\//, { timeout: 30_000 });
  }
  const agentOutput = page.locator('[data-automation-output]');
  const automationFailure = page.locator('main .text-destructive').last();
  await expect(agentOutput.or(automationFailure)).toBeVisible({ timeout: 180_000 });
  if ((await agentOutput.filter({ hasText: 'AUTOMATION_AGENT_SHELL_OK' }).count()) === 0) {
    throw new Error(`automation agent shell failed: ${(await automationFailure.textContent()) || 'missing output'}`);
  }

  expect(failedResponses, failedResponses.join('\n')).toEqual([]);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
