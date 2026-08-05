import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import ImageBuildPanel from './ImageBuildPanel.svelte';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  ensureDir: vi.fn(),
  listFiles: vi.fn(),
}));

vi.mock('../../lib/workspace/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/workspace/bindings')>();
  return { ...actual, workspaceBindings: { ensure: mocks.ensure } };
});

vi.mock('../../lib/workspace/local-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/workspace/local-api')>();
  return {
    ...actual,
    localWorkspaceApi: {
      ...actual.localWorkspaceApi,
      ensureDir: mocks.ensureDir,
      listFiles: mocks.listFiles,
    },
  };
});

const validYaml = `
name: demo
agents:
  writer:
    image: demo/writer:dev
    build:
      context: workspace/writer
      dockerfile: docker/Dockerfile
`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const binding = {
  projectKey: 'ws_0123456789abcdef0123456789abcdef',
  sourcePath: '/projects/demo/agent-compose.yaml',
  workspacePath: 'workspace',
};

beforeEach(() => {
  mocks.ensure.mockReset().mockResolvedValue(binding);
  mocks.ensureDir.mockReset().mockResolvedValue(undefined);
  mocks.listFiles.mockReset().mockResolvedValue({ files: [] });
});

test('shows an empty state for empty or malformed YAML', () => {
  const { rerender } = render(ImageBuildPanel, { yaml: '' });
  expect(screen.getByText('暂无镜像构建配置')).toBeInTheDocument();

  rerender({ yaml: 'agents: [invalid' });
  expect(screen.getByText('暂无镜像构建配置')).toBeInTheDocument();
});

test('presents a manageable image build source and binds its context directory', async () => {
  render(ImageBuildPanel, {
    yaml: validYaml,
    projectIdentity: 'project:demo',
    bindingProjectKey: 'ws_0123456789abcdef0123456789abcdef',
  });

  expect(screen.getAllByText('demo/writer:dev').length).toBeGreaterThan(0);
  expect(screen.getByText('workspace/writer')).toBeInTheDocument();
  expect(screen.getAllByText('docker/Dockerfile').length).toBeGreaterThan(0);
  await waitFor(() => expect(mocks.ensure).toHaveBeenCalledWith('project:demo:images', expect.objectContaining({
    projectKey: 'ws_0123456789abcdef0123456789abcdef',
  })));
  await waitFor(() => expect(mocks.ensureDir).toHaveBeenCalledWith(
    'ws_0123456789abcdef0123456789abcdef',
    'workspace/writer',
  ));
});

test('derives the legacy key from an injected legacy project source path', async () => {
  render(ImageBuildPanel, {
    yaml: validYaml,
    projectIdentity: 'project:legacy',
    bindingSourcePath: '/agent-compose-ui/projects/legacy/agent-compose.yml',
  });

  await waitFor(() => expect(mocks.ensure).toHaveBeenCalledWith('project:legacy:images', expect.objectContaining({
    legacyKey: 'legacy',
  })));
  await waitFor(() => expect(mocks.ensureDir).toHaveBeenCalledWith(binding.projectKey, 'workspace/writer'));
  expect(screen.getByText(/请上传包含 docker\/Dockerfile 的完整项目目录/)).toBeInTheDocument();
});

test('prefers an explicit legacy key over one derived from an injected source path', async () => {
  render(ImageBuildPanel, {
    yaml: validYaml,
    projectIdentity: 'project:legacy',
    bindingSourcePath: '/agent-compose-ui/projects/legacy/agent-compose.yml',
    bindingLegacyKey: 'explicit-legacy-key',
  });

  await waitFor(() => expect(mocks.ensure).toHaveBeenCalledWith('project:legacy:images', expect.objectContaining({
    legacyKey: 'explicit-legacy-key',
  })));
});

test('shows invalid path errors without resolving storage or enabling upload', async () => {
  render(ImageBuildPanel, {
    yaml: validYaml.replace('workspace/writer', '../writer'),
    projectIdentity: 'project:demo',
  });

  expect(screen.getByText('构建目录不能包含 .. 或超出项目目录')).toBeInTheDocument();
  expect(screen.queryByText('上传文件')).not.toBeInTheDocument();
  await Promise.resolve();
  expect(mocks.ensure).not.toHaveBeenCalled();
  expect(mocks.ensureDir).not.toHaveBeenCalled();
});

test('shows workspace file errors instead of the normal upload guidance', async () => {
  mocks.listFiles.mockRejectedValue(new Error('构建目录读取失败'));
  render(ImageBuildPanel, {
    yaml: validYaml,
    projectIdentity: 'project:demo',
    bindingProjectKey: 'ws_0123456789abcdef0123456789abcdef',
  });

  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('构建目录读取失败'));
  expect(screen.queryByText('镜像项目文件已关联')).not.toBeInTheDocument();
  expect(screen.queryByText(/请上传包含 docker\/Dockerfile 的完整项目目录/)).not.toBeInTheDocument();
});

test('keeps a pending binding when equivalent YAML rebuilds the source objects', async () => {
  const pending = deferred<typeof binding>();
  mocks.ensure.mockReturnValue(pending.promise);
  const { rerender } = render(ImageBuildPanel, {
    yaml: validYaml,
    projectIdentity: 'project:demo',
    bindingProjectKey: binding.projectKey,
  });
  await waitFor(() => expect(mocks.ensure).toHaveBeenCalledTimes(1));

  rerender({
    yaml: validYaml.replace('name: demo', 'name: renamed'),
    projectIdentity: 'project:demo',
    bindingProjectKey: binding.projectKey,
  });
  pending.resolve(binding);

  await waitFor(() => expect(mocks.ensureDir).toHaveBeenCalledWith(binding.projectKey, 'workspace/writer'));
  expect(mocks.ensure).toHaveBeenCalledTimes(1);
});

test('shows a binding loading state without upload or missing-file guidance', async () => {
  const pending = deferred<typeof binding>();
  mocks.ensure.mockReturnValue(pending.promise);
  render(ImageBuildPanel, {
    yaml: validYaml,
    projectIdentity: 'project:demo',
    bindingProjectKey: binding.projectKey,
  });

  expect(await screen.findByRole('status')).toHaveTextContent('正在解析项目存储');
  expect(screen.queryByText('上传文件')).not.toBeInTheDocument();
  expect(screen.queryByText(/缺少 docker\/Dockerfile/)).not.toBeInTheDocument();
  expect(screen.queryByText(/请上传包含 docker\/Dockerfile/)).not.toBeInTheDocument();
});

test('hides files and readiness from the previous agent while the next context binds', async () => {
  const secondBinding = deferred<typeof binding>();
  mocks.ensure.mockResolvedValueOnce(binding).mockReturnValueOnce(secondBinding.promise);
  mocks.listFiles.mockResolvedValueOnce({ files: [{ path: 'Dockerfile', dir: false, size: 10, mtimeMs: 1 }] });
  const yaml = `
name: demo
agents:
  writer:
    image: demo/writer:dev
    build:
      context: workspace/writer
      dockerfile: Dockerfile
  reviewer:
    image: demo/reviewer:dev
    build:
      context: workspace/reviewer
      dockerfile: Dockerfile
`;
  render(ImageBuildPanel, { yaml, projectIdentity: 'project:demo', bindingProjectKey: binding.projectKey });
  await screen.findByText('镜像项目文件已关联');

  await fireEvent.click(screen.getByRole('button', { name: /demo\/reviewer:dev/ }));

  expect(await screen.findByRole('status')).toHaveTextContent('正在解析项目存储');
  expect(screen.queryByText('镜像项目文件已关联')).not.toBeInTheDocument();
  expect(screen.queryByRole('treeitem', { name: /Dockerfile/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /demo\/reviewer:dev/ })).not.toHaveTextContent('已就绪');
});
