import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import Sidebar from '../../src/components/Sidebar.svelte';
import { store } from '../../src/lib/stores.svelte';
import { EMPTY_YAML_TEMPLATE } from '../../src/lib/yaml';
import { ScriptApiError } from '../../src/lib/scripts/api';

// vi.mock 的 factory 被 hoist，不能引用外部变量；用 vi.hoisted 提升mock对象。
const rpcMocks = vi.hoisted(() => ({
  projectService: {
    listProjects: vi.fn(),
    getProject: vi.fn(),
    removeProject: vi.fn(),
    applyProject: vi.fn(),
    validateProject: vi.fn(),
  },
}));
const scriptMocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
}));

vi.mock('../../src/lib/rpc', () => ({
  projectService: rpcMocks.projectService,
  runService: {},
  execService: {},
  sandboxService: {},
  sessionService: {},
  kernelService: {},
  agentService: {},
  loaderService: {},
  dashboardService: {},
  configService: {},
}));
vi.mock('../../src/lib/scripts/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/scripts/api')>();
  return { ...actual, scriptApi: { ...actual.scriptApi, deleteProject: scriptMocks.deleteProject } };
});

function makeProject(id: string, name: string, runningRunCount = 0) {
  return {
    projectId: id,
    name,
    sourcePath: `/${id}.yml`,
    runningRunCount,
    currentRevision: '',
    specHash: '',
    agentCount: 0,
    schedulerCount: 0,
    latestRunId: '',
    createdAt: '',
    updatedAt: '',
  };
}

beforeEach(() => {
  rpcMocks.projectService.listProjects.mockReset();
  rpcMocks.projectService.removeProject.mockReset();
  rpcMocks.projectService.getProject.mockReset();
  scriptMocks.deleteProject.mockReset();
  scriptMocks.deleteProject.mockResolvedValue(undefined);
  store.projects = [];
  store.currentPage = 'dashboard';
  store.activeProjectId = '';
  store.activeDraftId = '';
  store.browserDrafts = [];
  store.editorContent = '';
  store.runtimeView = { level: 'agents', agentName: '', runId: '', sessionId: '' };
  localStorage.clear();
  window.location.hash = '';
  vi.unstubAllGlobals();
});

describe('Sidebar', () => {
  it('shows and selects multiple saved drafts as separate application rows', async () => {
    rpcMocks.projectService.listProjects.mockResolvedValue({ projects: [], hasMore: false, nextOffset: 0 });
    store.editorContent = 'name: first-agent\nagents: []\n';
    store.saveEditorDraft();
    store.beginEditorDraft();
    store.editorContent = 'name: second-agent\nagents: []\n';
    store.saveEditorDraft();
    store.beginEditorDraft();

    render(Sidebar);

    expect(await screen.findByRole('button', { name: /first-agent.*草稿/ })).toBeInTheDocument();
    const draft = screen.getByRole('button', { name: /second-agent.*草稿/ });
    await fireEvent.click(draft);
    expect(store.activeProjectId).toBe('');
    expect(store.editorContent).toContain('name: second-agent');
  });

  it('deletes only the selected local draft without calling the daemon', async () => {
    rpcMocks.projectService.listProjects.mockResolvedValue({ projects: [], hasMore: false, nextOffset: 0 });
    store.editorContent = 'name: keep-draft\nagents: []\n';
    store.saveEditorDraft();
    store.beginEditorDraft();
    store.editorContent = 'name: disposable-draft\nagents: []\n';
    store.saveEditorDraft();
    vi.stubGlobal('confirm', () => true);
    render(Sidebar);

    await fireEvent.click(await screen.findByRole('button', { name: '删除草稿 disposable-draft' }));

    expect(screen.queryByText('disposable-draft')).not.toBeInTheDocument();
    expect(screen.getByText('keep-draft')).toBeInTheDocument();
    expect(store.browserDrafts.map((draft) => draft.name)).toEqual(['keep-draft']);
    expect(rpcMocks.projectService.removeProject).not.toHaveBeenCalled();
  });

  it('隐藏总览菜单', () => {
    render(Sidebar);
    expect(screen.queryByRole('button', { name: /总览/ })).not.toBeInTheDocument();
  });

  it('用单一系统管理入口替代资源和设置菜单', () => {
    render(Sidebar);
    expect(screen.getAllByRole('button', { name: /系统管理/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^镜像$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /缓存/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /数据卷/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^设置$/ })).not.toBeInTheDocument();
  });

  it('listProjects 返回后渲染项目列表与运行徽标', async () => {
    rpcMocks.projectService.listProjects.mockResolvedValue({
      projects: [makeProject('p1', '项目一', 0), makeProject('p2', '项目二', 2)],
    });
    render(Sidebar);
    await waitFor(() => expect(screen.getByText('项目一')).toBeInTheDocument());
    expect(screen.getByText('项目二')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('把名称筛选交给服务端并渲染返回结果', async () => {
    rpcMocks.projectService.listProjects.mockImplementation((request) => Promise.resolve({
      projects: request.query
        ? [makeProject('p1', 'alpha')]
        : [makeProject('p1', 'alpha'), makeProject('p2', 'beta')],
      hasMore: false,
      nextOffset: 0,
    }));
    render(Sidebar);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    const input = screen.getByPlaceholderText('筛选应用…');
    await fireEvent.input(input, { target: { value: 'alp' } });
    await waitFor(() => expect(screen.queryByText('beta')).not.toBeInTheDocument());
    expect(rpcMocks.projectService.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'alp', offset: 0, limit: 10 }),
    );
  });

  it('服务端还有下一页时显示加载更多并用 nextOffset 续载', async () => {
    const projects = Array.from({ length: 12 }, (_, i) => makeProject(`p${i}`, `proj${i}`));
    rpcMocks.projectService.listProjects.mockImplementation((request) => Promise.resolve(
      request.offset === 10
        ? { projects: projects.slice(10), hasMore: false, nextOffset: 0 }
        : { projects: projects.slice(0, 10), hasMore: true, nextOffset: 10 },
    ));
    render(Sidebar);
    await waitFor(() => expect(screen.getByText('proj0')).toBeInTheDocument());
    expect(screen.getByText(/加载更多/)).toBeInTheDocument();
    expect(screen.queryByText('proj10')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByText(/加载更多/));
    await waitFor(() => expect(screen.getByText('proj10')).toBeInTheDocument());
    expect(rpcMocks.projectService.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: '', offset: 10, limit: 10 }),
    );
  });

  it('确认删除后调用 removeProject 并刷新列表', async () => {
    rpcMocks.projectService.listProjects.mockResolvedValue({ projects: [makeProject('p1', '项目一')] });
    rpcMocks.projectService.removeProject.mockResolvedValue({});
    render(Sidebar);
    await waitFor(() => expect(screen.getByText('项目一')).toBeInTheDocument());
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const delBtn = document.querySelector('.project-delete') as HTMLButtonElement;
    await fireEvent.click(delBtn);
    await waitFor(() => expect(rpcMocks.projectService.removeProject).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Agent 与运行历史将保留'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('关联脚本目录会被永久删除'));
    expect(scriptMocks.deleteProject).toHaveBeenCalledWith('p1');
    expect(rpcMocks.projectService.listProjects).toHaveBeenCalledTimes(2);
  });

  it('应用删除成功但脚本清理失败时报告残留目录', async () => {
    rpcMocks.projectService.listProjects
      .mockResolvedValueOnce({ projects: [makeProject('p1', '项目一')] })
      .mockResolvedValue({ projects: [] });
    rpcMocks.projectService.removeProject.mockResolvedValue({});
    scriptMocks.deleteProject.mockRejectedValue(new Error('cleanup failed'));
    const toast = vi.spyOn(store, 'addToast').mockImplementation(() => {});
    render(Sidebar);
    await screen.findByText('项目一');
    vi.stubGlobal('confirm', () => true);
    await fireEvent.click(document.querySelector('.project-delete') as HTMLButtonElement);

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('脚本目录清理失败'), 'error'));
    expect(screen.queryByText('项目一')).not.toBeInTheDocument();
  });

  it('脚本目录本来不存在时仍报告应用删除成功', async () => {
    rpcMocks.projectService.listProjects
      .mockResolvedValueOnce({ projects: [makeProject('p1', '项目一')] })
      .mockResolvedValue({ projects: [] });
    rpcMocks.projectService.removeProject.mockResolvedValue({});
    scriptMocks.deleteProject.mockRejectedValue(new ScriptApiError(404, 'NOT_FOUND', '目标不存在'));
    const toast = vi.spyOn(store, 'addToast').mockImplementation(() => {});
    toast.mockClear();
    render(Sidebar);
    await screen.findByText('项目一');
    vi.stubGlobal('confirm', () => true);
    await fireEvent.click(document.querySelector('.project-delete') as HTMLButtonElement);

    await waitFor(() => expect(toast).toHaveBeenCalledWith('智能体应用 "项目一" 及关联脚本目录已删除', 'success'));
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('脚本目录清理失败'), 'error');
  });

  it('应用删除失败时保留脚本目录', async () => {
    rpcMocks.projectService.listProjects.mockResolvedValue({ projects: [makeProject('p1', '项目一')] });
    rpcMocks.projectService.removeProject.mockRejectedValue(new Error('remove failed'));
    render(Sidebar);
    await screen.findByText('项目一');
    vi.stubGlobal('confirm', () => true);
    await fireEvent.click(document.querySelector('.project-delete') as HTMLButtonElement);

    await waitFor(() => expect(rpcMocks.projectService.removeProject).toHaveBeenCalled());
    expect(scriptMocks.deleteProject).not.toHaveBeenCalled();
  });

  it('取消删除不调用 removeProject', async () => {
    rpcMocks.projectService.listProjects.mockResolvedValue({ projects: [makeProject('p1', '项目一')] });
    render(Sidebar);
    await waitFor(() => expect(screen.getByText('项目一')).toBeInTheDocument());
    vi.stubGlobal('confirm', () => false);
    const delBtn = document.querySelector('.project-delete') as HTMLButtonElement;
    await fireEvent.click(delBtn);
    expect(rpcMocks.projectService.removeProject).not.toHaveBeenCalled();
  });

  it('新建项目写入空模板并进入 project 页', async () => {
    rpcMocks.projectService.listProjects.mockResolvedValue({ projects: [] });
    render(Sidebar);
    await fireEvent.click(screen.getByText('+ 新建智能体应用'));
    expect(store.editorContent).toBe(EMPTY_YAML_TEMPLATE);
    expect(store.currentPage).toBe('project');
    expect(store.activeProjectId).toBe('');
  });

});
