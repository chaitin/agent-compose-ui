import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import ResourcePanel from './ResourcePanel.svelte';
import resourcePanelSource from './ResourcePanel.svelte?raw';
import { createScriptWorkspace } from '../lib/scripts/workspace.svelte';
import { skillApi } from '../lib/skills/api';

vi.mock('./scripts/ScriptEditor.svelte', async () => ({
  default: (await import('../test/fixtures/ScriptEditorStub.svelte')).default,
}));

vi.mock('../lib/skills/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/skills/api')>('../lib/skills/api');
  return { ...actual, skillApi: { ...actual.skillApi, list: vi.fn() } };
});

function createWorkspace(panelOpen = true) {
  const workspace = createScriptWorkspace({
    listTree: async () => ({ kind: 'directory', name: '', path: '', children: [] }),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    createFolder: vi.fn(),
    deleteFile: vi.fn(),
    deleteFolder: vi.fn(),
  });
  workspace.panelOpen = panelOpen;
  return workspace;
}

function installResourcePanelStyles(): () => void {
  const css = resourcePanelSource.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '';
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  return () => style.remove();
}

test('keeps three visible resource labels in a three-column grid row while hiding images and skills tabs', () => {
  const removeStyles = installResourcePanelStyles();
  const { container } = render(ResourcePanel, { workspace: createWorkspace(), yaml: '' });
  const panel = container.querySelector('.resource-panel') as HTMLElement;
  panel.style.width = '320px';
  const header = container.querySelector('.resource-tabs') as HTMLElement;
  const tablist = screen.getByRole('tablist');
  const headerStyle = getComputedStyle(header);
  const tablistStyle = getComputedStyle(tablist);

  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect(headerStyle.height).toBe('auto');
  expect(headerStyle.minHeight).toBe('32px');
  expect(tablistStyle.height).toBe('auto');
  expect(tablistStyle.minHeight).toBe('32px');
  expect(tablistStyle.display).toBe('grid');
  expect(tablistStyle.gridTemplateColumns).toMatch(/repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  for (const [tab, label] of screen.getAllByRole('tab').map((tab, index) => [tab, ['脚本文件', 'Workspace 文件', '数据与挂载'][index]] as const)) {
    const style = getComputedStyle(tab);
    expect(tab).toHaveTextContent(label);
    expect(style.whiteSpace).toBe('normal');
    expect(style.overflow).not.toBe('hidden');
    expect(style.textOverflow).not.toBe('ellipsis');
  }
  const hiddenTabs = screen.getAllByRole('tab', { hidden: true });
  expect(hiddenTabs).toHaveLength(5);
  const hiddenLabels = hiddenTabs.map((t) => t.textContent?.replace(/\d+$/, '').trim());
  expect(hiddenLabels).toEqual(expect.arrayContaining(['镜像', 'Skills']));
  removeStyles();
});

test('shows live image, Skill, and data-and-mount configuration counts from YAML', async () => {
  const workspace = createWorkspace();
  const firstYaml = `agents:
  alpha:
    build: { context: images/alpha }
    skills:
      - { name: review, source: file, path: ./skills/review }
      - { name: review, source: file, path: ./skills/review }
    volumes:
      - { type: volume, source: project-data, target: /data }
      - { type: bind, source: /srv/shared, target: /shared }
  beta:
    skills:
      - { name: review, source: file, path: ./skills/review }
    volumes:
      - { type: volume, source: build-cache, target: /cache }
volumes:
  project-data: {}
  build-cache: {}
`;
  const view = render(ResourcePanel, { workspace, yaml: firstYaml });

  expect(screen.getByRole('tab', { name: '镜像 1', hidden: true })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Skills 3', hidden: true })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '数据与挂载 5' })).toBeInTheDocument();

  await view.rerender({ workspace, yaml: 'agents:\n  gamma:\n    build: { context: images/gamma }\n    skills: [{ name: deploy, source: file }]\n' });
  expect(screen.getByRole('tab', { name: '镜像 1', hidden: true })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Skills 1', hidden: true })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '数据与挂载 0' })).toBeInTheDocument();
});

test('shows zero YAML resource counts when YAML is empty or invalid', async () => {
  const workspace = createWorkspace();
  const view = render(ResourcePanel, { workspace, yaml: '' });

  for (const label of ['镜像 0', 'Skills 0', '数据与挂载 0']) {
    expect(screen.getByRole('tab', { name: label, hidden: true })).toBeInTheDocument();
  }

  await view.rerender({ workspace, yaml: 'agents: [' });
  for (const label of ['镜像 0', 'Skills 0', '数据与挂载 0']) {
    expect(screen.getByRole('tab', { name: label, hidden: true })).toBeInTheDocument();
  }
});

test('shows zero for every YAML-derived count when ProjectSpec parsing rejects otherwise valid mounts', () => {
  render(ResourcePanel, { workspace: createWorkspace(), yaml: `agents:
  alpha:
    skills: invalid
    volumes:
      - { type: bind, source: /srv/shared, target: /shared }
volumes:
  data: {}
` });

  for (const label of ['镜像 0', 'Skills 0', '数据与挂载 0']) {
    expect(screen.getByRole('tab', { name: label, hidden: true })).toBeInTheDocument();
  }
});

test('keeps valid image and Skill counts when only the resource model rejects YAML', () => {
  render(ResourcePanel, { workspace: createWorkspace(), yaml: `agents:
  alpha:
    build: { context: images/alpha }
    skills: [{ name: review, source: file }]
volumes:
  has/slash: {}
` });

  expect(screen.getByRole('tab', { name: '镜像 1', hidden: true })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Skills 1', hidden: true })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '数据与挂载 0' })).toBeInTheDocument();
});

test('keeps three visible resource tabs and renders the images empty state via direct activation', async () => {
  const removeStyles = installResourcePanelStyles();
  const workspace = createWorkspace();
  render(ResourcePanel, { workspace, yaml: '' });

  const tabs = screen.getAllByRole('tab');
  expect(tabs).toHaveLength(3);
  expect(screen.queryByText('项目资源')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '折叠资源面板' })).toBeInTheDocument();
  expect(tabs.map((tab) => tab.textContent?.replace(/\d+$/, '').trim())).toEqual([
    '脚本文件', 'Workspace 文件', '数据与挂载',
  ]);

  expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('button', { name: '新建脚本' })).toBeInTheDocument();

  await fireEvent.click(tabs[1]);
  expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('文件管理不可用')).toBeInTheDocument();

  workspace.activeTab = 'images';
  await waitFor(() => expect(screen.getByText('暂无镜像构建配置')).toBeInTheDocument());
  removeStyles();
});

test('reopens a collapsed panel when a tab is selected', async () => {
  const workspace = createWorkspace(false);
  render(ResourcePanel, { workspace, yaml: '' });

  await fireEvent.click(screen.getByRole('tab', { name: /数据与挂载/ }));
  expect(workspace.panelOpen).toBe(true);
});

test('shows images placeholder when no build config exists', async () => {
  const workspace = createWorkspace();
  render(ResourcePanel, { workspace, yaml: 'name: test\n' });

  workspace.activeTab = 'images';
  await waitFor(() => expect(screen.getByText('暂无镜像构建配置')).toBeInTheDocument());
});

test('opens the existing Skills and data-and-mount panels with a valid direct binding', async () => {
  vi.mocked(skillApi.list).mockResolvedValue([]);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [] }), { headers: { 'content-type': 'application/json' } })));
  const projectKey = 'ws_0123456789abcdef0123456789abcdef';
  const workspace = createWorkspace();
  render(ResourcePanel, { workspace, projectKey, yaml: 'agents:\n  alpha: {}\n', onYamlChange: vi.fn(), onApply: vi.fn().mockResolvedValue(undefined) });

  workspace.activeTab = 'skills';
  expect(await screen.findByText('暂无 Skills')).toBeInTheDocument();

  await fireEvent.click(screen.getByRole('tab', { name: /数据与挂载/ }));
  await waitFor(() => expect(screen.getByRole('toolbar', { name: '数据与挂载操作' })).toBeInTheDocument());
});

test('uses the agent targeted by the YAML skills action', async () => {
  vi.mocked(skillApi.list).mockResolvedValue([]);
  const workspace = createWorkspace(false);
  workspace.openSkillsTab('beta');
  const projectKey = 'ws_0123456789abcdef0123456789abcdef';
  render(ResourcePanel, {
    workspace, projectKey,
    yaml: 'agents:\n  alpha: {}\n  beta:\n    skills: []\n',
    selectedAgent: 'alpha', onYamlChange: vi.fn(),
  });

  await fireEvent.click(await screen.findByRole('button', { name: '上传 Skill' }));

  expect(screen.getByLabelText('目标 Agent')).toHaveValue('beta');
});

test('moves focus across visible tabs with arrows, Home, and End', async () => {
  const removeStyles = installResourcePanelStyles();
  render(ResourcePanel, { workspace: createWorkspace(), yaml: '' });
  const tabs = screen.getAllByRole('tab');
  // visible tabs: scripts, workspace, mounts

  tabs[1].focus();
  await fireEvent.keyDown(tabs[1], { key: 'ArrowRight' });
  await waitFor(() => expect(tabs[2]).toHaveFocus());
  expect(tabs[2]).toHaveAttribute('aria-selected', 'true');

  await fireEvent.keyDown(tabs[2], { key: 'Home' });
  await waitFor(() => expect(tabs[0]).toHaveFocus());
  expect(tabs[0]).toHaveAttribute('aria-selected', 'true');

  await fireEvent.keyDown(tabs[0], { key: 'End' });
  await waitFor(() => expect(tabs[2]).toHaveFocus());
  removeStyles();
});
