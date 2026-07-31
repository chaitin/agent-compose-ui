import { describe, it, expect, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import {
  parseHash,
  buildHash,
  Store,
  store,
  type RuntimeView,
  type Page,
} from '../src/lib/stores.svelte';
import { EMPTY_YAML_TEMPLATE } from '../src/lib/yaml';

const LS_KEY = 'agent-compose-console';
const idle: RuntimeView = { level: 'agents', agentName: '', runId: '', sessionId: '' };

function rv(over: Partial<RuntimeView>): RuntimeView {
  return { level: 'agents', agentName: '', runId: '', sessionId: '', ...over };
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
  store.currentPage = 'dashboard';
  store.activeProjectId = '';
  store.editorContent = '';
  store.runtimeView = { ...idle };
  store.sandboxReturnView = null;
  store._syncing = false;
});

describe('parseHash', () => {
  it('dashboard', () => {
    const r = parseHash('#/dashboard')!;
    expect(r.page).toBe('dashboard');
    expect(r.runtimeView.level).toBe('agents');
  });

  it('settings', () => {
    const r = parseHash('#/settings')!;
    expect(r.page).toBe('settings');
  });

  it('resources/images', () => {
    const r = parseHash('#/resources/images')!;
    expect(r.page).toBe('images');
    expect(r.projectId).toBe('');
  });

  it('daemon cache and volume resources', () => {
    expect(parseHash('#/resources/caches')?.page).toBe('caches');
    expect(parseHash('#/resources/volumes')?.page).toBe('volumes');
  });

  it('system tokens', () => {
	  expect(parseHash('#/system/tokens')?.page).toBe('tokens');
	  expect(buildHash('tokens', '', idle)).toBe('#/system/tokens');
  });

  it('project/new', () => {
    const r = parseHash('#/project/new')!;
    expect(r.page).toBe('project');
    expect(r.projectId).toBe('');
  });

  it('project/<id>/agents', () => {
    const r = parseHash('#/project/p1/agents')!;
    expect(r.projectId).toBe('p1');
    expect(r.runtimeView.level).toBe('agents');
  });

  it('project/<id>/runtime', () => {
    const r = parseHash('#/project/p1/runtime')!;
    expect(r.runtimeView.level).toBe('project-runtime');
  });

  it('project/<id>/agent/<name>/sandboxes', () => {
    const r = parseHash('#/project/p1/agent/review%20bot/sandboxes')!;
    expect(r.runtimeView).toMatchObject({ level: 'agent-sandboxes', agentName: 'review bot' });
    expect(parseHash('#/project/p1/sandboxes')).toBeNull();
  });

  it('project/<id>/sandbox/<sandboxId>', () => {
    const r = parseHash('#/project/p1/sandbox/sandbox%2Fa%20b')!;
    expect(r.runtimeView).toMatchObject({ level: 'sandbox-detail', sandboxId: 'sandbox/a b' });
    expect(parseHash('#/project/p1/sandbox/%E0%A4%A')).toBeNull();
  });

  it('project/<id>/schedulers', () => {
    const r = parseHash('#/project/p1/schedulers')!;
    expect(r.runtimeView.level).toBe('schedulers');
  });

  it('project/<id>/loader-runs', () => {
    const r = parseHash('#/project/p1/loader-runs')!;
    expect(r.runtimeView.level).toBe('loader-runs');
  });

  it('project/<id>/loader-run/<lid>/<rid>', () => {
    const r = parseHash('#/project/p1/loader-run/L1/R1')!;
    expect(r.runtimeView.level).toBe('loader-run-detail');
    expect(r.runtimeView.loaderId).toBe('L1');
    expect(r.runtimeView.runId).toBe('R1');
  });

  it('project/<id>/loader-run/<lid>/<rid>/session/<sid>', () => {
    const r = parseHash('#/project/p1/loader-run/L1/R1/session/S1')!;
    expect(r.runtimeView.level).toBe('session');
    expect(r.runtimeView.sessionId).toBe('S1');
  });

  it('project/<id>/agent/<name>', () => {
    const r = parseHash('#/project/p1/agent/a1')!;
    expect(r.runtimeView.level).toBe('agent-detail');
    expect(r.runtimeView.agentName).toBe('a1');
  });

  it('project/<id>/agent/<name>/run/<rid>', () => {
    const r = parseHash('#/project/p1/agent/a1/run/R1')!;
    expect(r.runtimeView.level).toBe('run-detail');
    expect(r.runtimeView.agentName).toBe('a1');
    expect(r.runtimeView.runId).toBe('R1');
  });

  it('project/<id>/agent/<name>/run/<rid>/session/<sid>', () => {
    const r = parseHash('#/project/p1/agent/a1/run/R1/session/S1')!;
    expect(r.runtimeView.level).toBe('session');
    expect(r.runtimeView.runId).toBe('R1');
    expect(r.runtimeView.sessionId).toBe('S1');
  });

  it('project/<id>/agent/<name>/session/<sid>', () => {
    const r = parseHash('#/project/p1/agent/a1/session/S1')!;
    expect(r.runtimeView.level).toBe('session');
    expect(r.runtimeView.agentName).toBe('a1');
    expect(r.runtimeView.sessionId).toBe('S1');
  });

  it('URL 编码的 agentName / runId 被解码', () => {
    const name = encodeURIComponent('agent 1');
    const r = parseHash(`#/project/p1/agent/${name}`)!;
    expect(r.runtimeView.agentName).toBe('agent 1');
  });

  it('空或无法识别的 hash 返回 null', () => {
    expect(parseHash('')).toBeNull();
    expect(parseHash('#/')).toBeNull();
    expect(parseHash('#/unknown')).toBeNull();
  });
});

describe('buildHash', () => {
  it('dashboard / system management / 无 id -> new', () => {
    expect(buildHash('dashboard', '', idle)).toBe('#/dashboard');
    expect(buildHash('settings', '', idle)).toBe('#/system/capabilities');
    expect(buildHash('environment', '', idle)).toBe('#/system/environment');
    expect(buildHash('project', '', idle)).toBe('#/project/new');
    expect(buildHash('images', 'kept-project', idle)).toBe('#/system/images');
    expect(buildHash('caches', 'kept-project', idle)).toBe('#/resources/caches');
    expect(buildHash('volumes', 'kept-project', idle)).toBe('#/resources/volumes');
  });

  it('各 runtime level 生成对应 hash', () => {
    expect(buildHash('project', 'p1', rv({ level: 'agents' }))).toBe('#/project/p1/agents');
    expect(buildHash('project', 'p1', rv({ level: 'project-runtime' }))).toBe('#/project/p1/runtime');
    expect(buildHash('project', 'p1', rv({ level: 'latest-run' }))).toBe('#/project/p1/latest-run');
    expect(buildHash('project', 'p1', rv({ level: 'agent-sandboxes', agentName: 'review bot' }))).toBe('#/project/p1/agent/review%20bot/sandboxes');
    expect(buildHash('project', 'p1', rv({ level: 'sandbox-detail', sandboxId: 'sandbox/a b' }))).toBe('#/project/p1/sandbox/sandbox%2Fa%20b');
    expect(buildHash('project', 'p1', rv({ level: 'schedulers' }))).toBe('#/project/p1/schedulers');
    expect(buildHash('project', 'p1', rv({ level: 'loader-runs' }))).toBe('#/project/p1/loader-runs');
    expect(buildHash('project', 'p1', rv({ level: 'loader-run-detail', loaderId: 'L1', runId: 'R1' })))
      .toBe('#/project/p1/loader-run/L1/R1');
    expect(buildHash('project', 'p1', rv({ level: 'agent-detail', agentName: 'a1' })))
      .toBe('#/project/p1/agent/a1');
    expect(buildHash('project', 'p1', rv({ level: 'run-detail', agentName: 'a1', runId: 'R1' })))
      .toBe('#/project/p1/agent/a1/run/R1');
  });

  it('latest-run hash reloads into the latest run route', () => {
    expect(parseHash('#/project/p1/latest-run')?.runtimeView.level).toBe('latest-run');
  });

  it('session 优先 loader-run 形态，其次 run 形态，最后 agent 形态', () => {
    expect(buildHash('project', 'p1', rv({ level: 'session', loaderId: 'L1', runId: 'R1', sessionId: 'S1' })))
      .toBe('#/project/p1/loader-run/L1/R1/session/S1');
    expect(buildHash('project', 'p1', rv({ level: 'session', agentName: 'a1', runId: 'R1', sessionId: 'S1' })))
      .toBe('#/project/p1/agent/a1/run/R1/session/S1');
    expect(buildHash('project', 'p1', rv({ level: 'session', agentName: 'a1', sessionId: 'S1' })))
      .toBe('#/project/p1/agent/a1/session/S1');
  });

  it('特殊字符被编码', () => {
    expect(buildHash('project', 'p1', rv({ level: 'agent-detail', agentName: 'a 1' })))
      .toBe(`#/project/p1/agent/${encodeURIComponent('a 1')}`);
  });
});

describe('parseHash ↔ buildHash 往返', () => {
  const cases: string[] = [
    '#/dashboard',
    '#/system/capabilities',
    '#/system/environment',
    '#/system/images',
    '#/system/webhooks',
    '#/system/tokens',
    '#/resources/caches',
    '#/resources/volumes',
    '#/project/new',
    '#/project/p1/agents',
    '#/project/p1/runtime',
    '#/project/p1/loader-runs',
    '#/project/p1/loader-run/L1/R1',
    '#/project/p1/loader-run/L1/R1/session/S1',
    '#/project/p1/agent/a1',
    '#/project/p1/agent/a1/run/R1',
    '#/project/p1/agent/a1/run/R1/session/S1',
    '#/project/p1/agent/a1/session/S1',
  ];
  for (const hash of cases) {
    it(`${hash} 解析后再构建应保持一致`, () => {
      const parsed = parseHash(hash)!;
      const rebuilt = buildHash(parsed.page, parsed.projectId, parsed.runtimeView);
      expect(rebuilt).toBe(hash);
    });
  }
});

describe('Store 路由行为', () => {
  it('无 URL 路由时默认进入空 YAML 新建页', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ activeProjectId: 'old-project', editorContent: 'old yaml' }));
    window.location.hash = '';
    const fresh = new Store();
    expect(fresh.currentPage).toBe('project');
    expect(fresh.activeProjectId).toBe('');
    expect(fresh.editorContent).toBe(EMPTY_YAML_TEMPLATE);
    expect(window.location.search).toBe('?sandboxTab=files');
    expect(window.location.hash).toBe('#/project/new');
  });

  it('明确 URL 路由优先于默认新建页', () => {
    window.location.hash = '#/system/images';
    const fresh = new Store();
    expect(fresh.currentPage).toBe('images');
  });

  it('hashchange 还原 runtimeView 与 projectId', () => {
    window.location.hash = '#/project/p1/runtime';
    window.dispatchEvent(new Event('hashchange'));
    expect(store.runtimeView.level).toBe('project-runtime');
    expect(store.activeProjectId).toBe('p1');
  });

  it('navigateTo 更新 runtimeView 并同步 hash', () => {
    store.currentPage = 'project';
    store.activeProjectId = 'p1';
    store.navigateTo('run-detail', { agentName: 'a1', runId: 'r1' });
    expect(store.runtimeView.level).toBe('run-detail');
    expect(store.runtimeView.agentName).toBe('a1');
    expect(store.runtimeView.runId).toBe('r1');
    expect(window.location.hash).toBe('#/project/p1/agent/a1/run/r1');
  });

  it('navigateTo Sandbox 详情时清除旧 Run 上下文', () => {
    store.currentPage = 'project';
    store.activeProjectId = 'p1';
    store.runtimeView = rv({ level: 'run-detail', agentName: 'collector', runId: 'run-1' });
    store.navigateTo('sandbox-detail', { sandboxId: 'sandbox-1' });
    expect(store.runtimeView).toMatchObject({
      level: 'sandbox-detail', sandboxId: 'sandbox-1', agentName: '', runId: '', sessionId: '',
    });
    expect(window.location.hash).toBe('#/project/p1/sandbox/sandbox-1');
  });

  it('从 Run 进入 Sandbox 详情后返回原 Run', () => {
    store.currentPage = 'project';
    store.activeProjectId = 'p1';
    store.runtimeView = rv({ level: 'run-detail', agentName: 'collector', runId: 'run-1' });
    store.navigateTo('sandbox-detail', { sandboxId: 'sandbox-1' });
    store.navigateBack();
    expect(store.runtimeView).toMatchObject({ level: 'run-detail', agentName: 'collector', runId: 'run-1' });
    expect(window.location.hash).toBe('#/project/p1/agent/collector/run/run-1');
  });

  it('navigateBack 从 run-detail 回到 agent-detail', () => {
    store.currentPage = 'project';
    store.activeProjectId = 'p1';
    store.navigateTo('run-detail', { agentName: 'a1', runId: 'r1' });
    store.navigateBack();
    expect(store.runtimeView.level).toBe('agent-detail');
    expect(store.runtimeView.agentName).toBe('a1');
    expect(store.runtimeView.runId).toBe('');
  });

  it('navigateBack 从 schedulers 回到智能体列表', () => {
    store.currentPage = 'project';
    store.activeProjectId = 'p1';
    store.navigateTo('schedulers');
    store.navigateBack();
    expect(store.runtimeView.level).toBe('agents');
    expect(window.location.hash).toBe('#/project/p1/agents');
  });

  it('navigateBack 从 Agent Sandbox 清单回到 Agent', () => {
    store.currentPage = 'project';
    store.activeProjectId = 'p1';
    store.navigateTo('agent-sandboxes', { agentName: 'review bot' });
    store.navigateBack();
    expect(store.runtimeView).toMatchObject({ level: 'agent-detail', agentName: 'review bot' });
    expect(window.location.hash).toBe('#/project/p1/agent/review%20bot');
  });

  it('goTo 更新 page 并同步 hash', () => {
    store.goTo('settings');
    expect(store.currentPage).toBe('settings');
    expect(window.location.hash).toBe('#/system/capabilities');
  });
});

describe('localStorage 持久化', () => {
  it('明确访问具体项目时从 localStorage 恢复 editorContent', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ activeProjectId: 'restored-id', editorContent: 'editor-yaml' }));
    window.location.hash = '#/project/restored-id/agents';
    const s = new Store();
    expect(s.activeProjectId).toBe('restored-id');
    expect(s.editorContent).toBe('editor-yaml');
  });

  it('activeProjectId / editorContent 变更后持久化', () => {
    store.activeProjectId = 'persisted-id';
    store.editorContent = 'persisted-yaml';
    flushSync();
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
    expect(raw!).toContain('persisted-id');
    expect(raw!).toContain('persisted-yaml');
  });
});

describe('triggerRuntimeRefresh', () => {
  it('递增 runtimeRefreshVersion', () => {
    const before = store.runtimeRefreshVersion;
    store.triggerRuntimeRefresh();
    expect(store.runtimeRefreshVersion).toBe(before + 1);
  });
});
