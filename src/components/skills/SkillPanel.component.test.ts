import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import SkillPanel from './SkillPanel.svelte';
import { skillApi } from '../../lib/skills/api';
import { yamlToSpec } from '../../lib/yaml';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

vi.mock('../../lib/skills/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/skills/api')>('../../lib/skills/api');
  return { ...actual, skillApi: { list: vi.fn(), create: vi.fn(), mkdir: vi.fn(), upload: vi.fn(), read: vi.fn(), write: vi.fn(), remove: vi.fn() } };
});

const yaml = `name: test\nagents:\n  beta: {}\n  alpha:\n    skills:\n      - name: demo\n        source: file\n        path: ./skills/demo\n`;
const entry = { path: 'demo', name: 'demo', isDir: true, size: 0, modTime: 'now' };
const file = { path: 'demo/SKILL.md', name: 'SKILL.md', isDir: false as const, size: 4, modTime: 'now', sha256: 'old', content: 'body' };
const KEY_A = 'ws_0123456789abcdef0123456789abcdef';
const KEY_B = 'ws_fedcba9876543210fedcba9876543210';

beforeEach(() => {
  vi.mocked(skillApi.list).mockReset().mockResolvedValue([entry]);
  vi.mocked(skillApi.create).mockReset();
  vi.mocked(skillApi.mkdir).mockReset().mockResolvedValue();
  vi.mocked(skillApi.upload).mockReset();
  vi.mocked(skillApi.read).mockReset().mockResolvedValue(file);
  vi.mocked(skillApi.write).mockReset();
  vi.mocked(skillApi.remove).mockReset().mockResolvedValue();
});

test('presents Skills as a toolbar, navigation list and editor', async () => {
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });

  expect(screen.getByRole('toolbar', { name: 'Skill 操作' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '新建 Skill' })).toHaveClass('primary');
  expect(screen.getByRole('button', { name: '上传 Skill' })).toHaveClass('secondary');
  expect(screen.getByRole('button', { name: '刷新' })).toHaveClass('ghost');
  expect(screen.getByRole('navigation', { name: 'Skills 列表' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Skill 编辑器' })).toBeInTheDocument();

  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  expect(await screen.findByRole('textbox', { name: 'demo/SKILL.md' })).toHaveValue('body');
});

test('uses the shared action hierarchy outside the Skills toolbar', async () => {
  vi.mocked(skillApi.list).mockRejectedValueOnce(new Error('offline'));
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });

  expect(await screen.findByRole('button', { name: '重试加载' })).toHaveClass('ui-button', 'secondary');
  await fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
  const dialog = screen.getByRole('dialog', { name: '新建 Skill' });
  expect(dialog).toHaveClass('resource-modal-card');
  expect(dialog).toHaveClass('command-modal');
  expect(dialog.parentElement).toHaveClass('resource-modal-backdrop');
  expect(screen.getByLabelText('Skill 名称').closest('.command-fields')).toBe(screen.getByLabelText('目标 Agent').closest('.command-fields'));
  expect(within(dialog).getByText('SKILL / CREATE')).toHaveClass('command-context');
  expect(within(dialog).getByRole('button', { name: '取消' })).toHaveClass('ui-button', 'ghost');
  expect(within(dialog).getByRole('button', { name: '创建 Skill' })).toHaveClass('ui-button', 'primary');
});

test('uses the resource-panel modal boundary for Skill upload', async () => {
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  await fireEvent.click(screen.getByRole('button', { name: '上传 Skill' }));
  const dialog = screen.getByRole('dialog', { name: '上传 Skill' });
  expect(dialog).toHaveClass('resource-modal-card');
  expect(dialog).toHaveClass('command-modal');
  expect(dialog.parentElement).toHaveClass('resource-modal-backdrop');
  expect(screen.getByLabelText('选择 SKILL.md').closest('.command-fields')).toBe(screen.getByLabelText('目标 Agent').closest('.command-fields'));
  expect(within(dialog).getByText('SKILL / UPLOAD')).toHaveClass('command-context');
});

test('confirms before navigating away from a Skill with unsaved changes', async () => {
  const review = { ...entry, path: 'review', name: 'review' };
  vi.mocked(skillApi.list).mockResolvedValue([entry, review]);
  vi.mocked(skillApi.read).mockImplementation(async (_key, path) => ({
    ...file,
    path,
    content: path.startsWith('review/') ? '---\nname: review\n---\n' : 'body',
  }));
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });

  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  const demoEditor = await screen.findByRole('textbox', { name: 'demo/SKILL.md' });
  await fireEvent.input(demoEditor, { target: { value: 'local edit' } });
  await fireEvent.click(screen.getByRole('button', { name: 'review' }));

  expect(screen.getByRole('dialog', { name: '放弃未保存更改？' })).toBeInTheDocument();
  expect(skillApi.read).toHaveBeenCalledTimes(1);
  expect(demoEditor).toHaveValue('local edit');

  await fireEvent.click(screen.getByRole('button', { name: '放弃并切换' }));
  expect(await screen.findByRole('textbox', { name: 'review/SKILL.md' })).toHaveValue('---\nname: review\n---\n');
  expect(skillApi.read).toHaveBeenCalledTimes(2);
});

test('does not request project files before receiving a canonical storage key', async () => {
  render(SkillPanel, { projectKey: 'daemon-project-id', yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  await Promise.resolve();
  expect(skillApi.list).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '新建 Skill' })).toBeDisabled();
});

test('opens creation from the toolbar instead of showing a persistent form', async () => {
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  expect(screen.queryByRole('textbox', { name: 'Skill 名称' })).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
  expect(screen.getByRole('dialog', { name: '新建 Skill' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Skill 名称' })).toHaveFocus();
});

test('uploads one UTF-8 SKILL.md through existing folder and upload APIs', async () => {
  vi.mocked(skillApi.list).mockResolvedValue([]);
  vi.mocked(skillApi.upload).mockResolvedValue({ ...file, path: 'review/SKILL.md' });
  const onYamlChange = vi.fn();
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'beta', onYamlChange });
  await screen.findByText('暂无 Skills');
  await fireEvent.click(screen.getByRole('button', { name: '上传 Skill' }));
  const dialog = screen.getByRole('dialog', { name: '上传 Skill' });
  const upload = new File(['---\nname: review\ndescription: review\n---\n'], 'SKILL.md', { type: 'text/markdown' });
  await fireEvent.change(within(dialog).getByLabelText('选择 SKILL.md'), { target: { files: [upload] } });
  await fireEvent.click(within(dialog).getByRole('button', { name: '确认上传' }));
  await waitFor(() => expect(skillApi.mkdir).toHaveBeenCalledWith(KEY_A, 'review'));
  expect(skillApi.upload).toHaveBeenCalledWith(KEY_A, 'review/SKILL.md', upload);
  expect(onYamlChange).toHaveBeenCalledWith(expect.stringContaining('./skills/review'));
});

test('rejects unsupported Skill upload names before API calls', async () => {
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  await fireEvent.click(screen.getByRole('button', { name: '上传 Skill' }));
  const dialog = screen.getByRole('dialog', { name: '上传 Skill' });
  await fireEvent.change(within(dialog).getByLabelText('选择 SKILL.md'), {
    target: { files: [new File(['body'], 'skills.zip', { type: 'application/zip' })] },
  });
  expect(within(dialog).getByRole('alert')).toHaveTextContent('仅支持名为 SKILL.md');
  expect(skillApi.mkdir).not.toHaveBeenCalled();
  expect(skillApi.upload).not.toHaveBeenCalled();
});

test('explains the lowercase name requirement for invalid Skill metadata', async () => {
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  await fireEvent.click(screen.getByRole('button', { name: '上传 Skill' }));
  const dialog = screen.getByRole('dialog', { name: '上传 Skill' });
  const upload = new File([
    '---\nname: AIWAF-host-investigation\ndescription: host investigation\n---\n',
  ], 'SKILL.md', { type: 'text/markdown' });

  await fireEvent.change(within(dialog).getByLabelText('选择 SKILL.md'), { target: { files: [upload] } });

  expect(within(dialog).getByRole('alert')).toHaveTextContent(
    'SKILL.md 的 name 字段只能包含小写字母、数字和连字符（-）',
  );
  expect(skillApi.mkdir).not.toHaveBeenCalled();
  expect(skillApi.upload).not.toHaveBeenCalled();
});

test('loads, selects and saves SKILL.md with optimistic concurrency', async () => {
  vi.mocked(skillApi.write).mockResolvedValue({ ...file, sha256: 'new' });
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  const editor = await screen.findByRole('textbox', { name: 'demo/SKILL.md' });
  await fireEvent.input(editor, { target: { value: 'changed' } });
  expect(screen.getByRole('button', { name: '保存 Skill' })).toBeEnabled();
  await fireEvent.click(screen.getByRole('button', { name: '保存 Skill' }));
  expect(skillApi.write).toHaveBeenCalledWith(KEY_A, 'demo/SKILL.md', 'changed', 'old');
  await waitFor(() => expect(screen.getByText('已保存')).toBeInTheDocument());
});

test('previews and confirms synchronization of an uploaded Skill to the canonical YAML path', async () => {
  const onYamlChange = vi.fn();
  const wrongPathYaml = `name: test\nagents:\n  alpha:\n    skills:\n      - name: demo\n        source: file\n        path: /workspace/SKILL.md\n`;
  render(SkillPanel, { projectKey: KEY_A, yaml: wrongPathYaml, selectedAgent: 'alpha', onYamlChange });
  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));

  await fireEvent.click(screen.getByRole('button', { name: '同步配置' }));

  const dialog = screen.getByRole('dialog', { name: '同步 Skill 配置' });
  expect(within(dialog).getByText('/workspace/SKILL.md')).toBeInTheDocument();
  expect(within(dialog).getByText('./skills/demo')).toBeInTheDocument();
  expect(onYamlChange).not.toHaveBeenCalled();

  await fireEvent.click(within(dialog).getByRole('button', { name: '确认同步' }));
  expect(onYamlChange).toHaveBeenCalledWith(expect.stringContaining('path: ./skills/demo'));
});

test('preserves local edits on conflict and offers reload', async () => {
  const { SkillApiError } = await import('../../lib/skills/api');
  vi.mocked(skillApi.write).mockRejectedValue(new SkillApiError(409, 'content_conflict', 'changed elsewhere'));
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  const editor = await screen.findByRole('textbox', { name: 'demo/SKILL.md' });
  await fireEvent.input(editor, { target: { value: 'mine' } });
  await fireEvent.click(screen.getByRole('button', { name: '保存 Skill' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('冲突');
  expect(editor).toHaveValue('mine');
  expect(screen.getByRole('button', { name: '重新加载磁盘内容' })).toBeInTheDocument();
});

test('creates files before YAML and compensates if YAML callback fails', async () => {
  vi.mocked(skillApi.list).mockResolvedValue([]);
  vi.mocked(skillApi.create).mockResolvedValue({ ...file, path: 'new-skill/SKILL.md' });
  const onYamlChange = vi.fn(() => { throw new Error('editor rejected'); });
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'beta', onYamlChange });
  await screen.findByText('暂无 Skills');
  await fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
  await fireEvent.input(screen.getByRole('textbox', { name: 'Skill 名称' }), { target: { value: 'new-skill' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建 Skill' }));
  await waitFor(() => expect(skillApi.remove).toHaveBeenCalledWith(KEY_A, 'new-skill', true));
  expect(onYamlChange).toHaveBeenCalledWith(expect.stringContaining('./skills/new-skill'));
  expect(screen.getByRole('alert')).toHaveTextContent('已回滚');
});

test('creates standard Skill YAML that the real apply parser accepts', async () => {
  vi.mocked(skillApi.list).mockResolvedValue([]);
  vi.mocked(skillApi.create).mockResolvedValue({ ...file, path: 'new-skill/SKILL.md' });
  const onYamlChange = vi.fn();
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'beta', onYamlChange });
  await screen.findByText('暂无 Skills');
  await fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
  await fireEvent.input(screen.getByRole('textbox', { name: 'Skill 名称' }), { target: { value: 'new-skill' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建 Skill' }));
  await waitFor(() => expect(onYamlChange).toHaveBeenCalledOnce());
  const changed = onYamlChange.mock.calls[0][0] as string;
  expect(changed).toContain('provider: file');
  const parsed = yamlToSpec(changed);
  expect(parsed.error).toBeUndefined();
  expect(parsed.spec.agents.find((agent) => agent.name === 'beta')?.skills[0]).toMatchObject({
    name: 'new-skill', provider: 'file', path: './skills/new-skill',
  });
});

test('lists all references before confirmation and updates YAML before deleting files', async () => {
  const order: string[] = [];
  const onYamlChange = vi.fn((_: string) => { order.push('yaml'); });
  vi.mocked(skillApi.remove).mockImplementation(async () => { order.push('files'); });
  const view = render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange });
  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除 Skill' }));
  const dialog = screen.getByRole('dialog', { name: /确认删除/ });
  expect(within(dialog).getByText('alpha')).toBeInTheDocument();
  expect(skillApi.remove).not.toHaveBeenCalled();
  await fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(skillApi.remove).toHaveBeenCalledWith(KEY_A, 'demo', true));
  expect(order).toEqual(['yaml', 'files']);
  expect(onYamlChange.mock.calls[0][0]).not.toContain('./skills/demo');
});

test('keeps selected content and dirty edits when YAML or selectedAgent props change', async () => {
  const view = render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  const editor = await screen.findByRole('textbox', { name: 'demo/SKILL.md' });
  await fireEvent.input(editor, { target: { value: 'dirty edit' } });
  await view.rerender({ projectKey: KEY_A, yaml: `${yaml}\n# parent update`, selectedAgent: 'beta', onYamlChange: vi.fn() });
  expect(screen.getByRole('textbox', { name: 'demo/SKILL.md' })).toHaveValue('dirty edit');
  expect(skillApi.list).toHaveBeenCalledTimes(1);
});

test('keeps edits made during save dirty and ignores a late save after project switch', async () => {
  const pending = deferred<typeof file>();
  vi.mocked(skillApi.write).mockReturnValue(pending.promise);
  const view = render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  const editor = await screen.findByRole('textbox', { name: 'demo/SKILL.md' });
  await fireEvent.input(editor, { target: { value: 'request body' } });
  await fireEvent.click(screen.getByRole('button', { name: '保存 Skill' }));
  await fireEvent.input(editor, { target: { value: 'typed later' } });
  pending.resolve({ ...file, sha256: 'new' });
  await waitFor(() => expect(screen.getByRole('button', { name: '保存 Skill' })).toBeEnabled());
  expect(editor).toHaveValue('typed later');

  const second = deferred<typeof file>();
  vi.mocked(skillApi.write).mockReturnValue(second.promise);
  await fireEvent.click(screen.getByRole('button', { name: '保存 Skill' }));
  await view.rerender({ projectKey: KEY_B, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  second.resolve({ ...file, sha256: 'late' });
  await waitFor(() => expect(skillApi.list).toHaveBeenCalledWith(KEY_B));
  expect(screen.queryByText('已保存')).not.toBeInTheDocument();
});

test('compensates a captured create identity when props and input change midflight', async () => {
  const pending = deferred<typeof file>();
  vi.mocked(skillApi.list).mockResolvedValue([]);
  vi.mocked(skillApi.create).mockReturnValue(pending.promise);
  const onYamlChange = vi.fn(() => { throw new Error('rejected'); });
  const view = render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange });
  await screen.findByText('暂无 Skills');
  await fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
  const input = screen.getByRole('textbox', { name: 'Skill 名称' });
  await fireEvent.input(input, { target: { value: 'captured' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建 Skill' }));
  await view.rerender({ projectKey: KEY_B, yaml, selectedAgent: 'beta', onYamlChange });
  pending.resolve({ ...file, path: 'captured/SKILL.md' });
  await waitFor(() => expect(skillApi.remove).toHaveBeenCalledWith(KEY_A, 'captured', true));
});

test('rebases a deferred create onto the latest same-project YAML', async () => {
  const pending = deferred<typeof file>();
  vi.mocked(skillApi.list).mockResolvedValue([]);
  vi.mocked(skillApi.create).mockReturnValue(pending.promise);
  const onYamlChange = vi.fn();
  const view = render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange });
  await screen.findByText('暂无 Skills');
  await fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
  await fireEvent.input(screen.getByRole('textbox', { name: 'Skill 名称' }), { target: { value: 'fresh' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建 Skill' }));
  const latestYaml = `${yaml}\nx-concurrent: preserved\n`;
  await view.rerender({ projectKey: KEY_A, yaml: latestYaml, selectedAgent: 'alpha', onYamlChange });
  pending.resolve({ ...file, path: 'fresh/SKILL.md' });
  await waitFor(() => expect(onYamlChange).toHaveBeenCalled());
  expect(onYamlChange.mock.calls[0][0]).toContain('x-concurrent: preserved');
  expect(onYamlChange.mock.calls[0][0]).toContain('./skills/fresh');
});

test('uses the current equivalent callback after a same-project parent rerender', async () => {
  const pending = deferred<typeof file>();
  vi.mocked(skillApi.list).mockResolvedValue([]);
  vi.mocked(skillApi.create).mockReturnValue(pending.promise);
  const oldCallback = vi.fn();
  const currentCallback = vi.fn();
  const view = render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: oldCallback });
  await screen.findByText('暂无 Skills');
  await fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
  await fireEvent.input(screen.getByRole('textbox', { name: 'Skill 名称' }), { target: { value: 'callback-fresh' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建 Skill' }));
  await view.rerender({
    projectKey: KEY_A,
    yaml: `${yaml}\nx-rerendered: preserved\n`,
    selectedAgent: 'alpha',
    onYamlChange: currentCallback,
  });
  pending.resolve({ ...file, path: 'callback-fresh/SKILL.md' });
  await waitFor(() => expect(currentCallback).toHaveBeenCalledTimes(1));
  expect(oldCallback).not.toHaveBeenCalled();
  expect(skillApi.remove).not.toHaveBeenCalled();
  expect(currentCallback.mock.calls[0][0]).toContain('x-rerendered: preserved');
  expect(currentCallback.mock.calls[0][0]).toContain('./skills/callback-fresh');
});

test('compensates create when the captured target Agent disappears during the request', async () => {
  const pending = deferred<typeof file>();
  vi.mocked(skillApi.list).mockResolvedValue([]);
  vi.mocked(skillApi.create).mockReturnValue(pending.promise);
  const onYamlChange = vi.fn();
  const view = render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange });
  await screen.findByText('暂无 Skills');
  await fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
  await fireEvent.input(screen.getByRole('textbox', { name: 'Skill 名称' }), { target: { value: 'orphan-safe' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建 Skill' }));
  await view.rerender({ projectKey: KEY_A, yaml: 'name: test\nagents:\n  beta: {}\n', selectedAgent: 'beta', onYamlChange });
  pending.resolve({ ...file, path: 'orphan-safe/SKILL.md' });
  await waitFor(() => expect(skillApi.remove).toHaveBeenCalledWith(KEY_A, 'orphan-safe', true));
  expect(onYamlChange).not.toHaveBeenCalled();
});

test('does not continue an old create into the new project after its list resolves late', async () => {
  const pendingA = deferred<typeof entry[]>();
  vi.mocked(skillApi.list)
    .mockResolvedValueOnce([])
    .mockReturnValueOnce(pendingA.promise)
    .mockResolvedValueOnce([]);
  vi.mocked(skillApi.create).mockResolvedValue({ ...file, path: 'race/SKILL.md' });
  const onYamlChange = vi.fn();
  const view = render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange });
  await screen.findByText('暂无 Skills');
  await fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
  await fireEvent.input(screen.getByRole('textbox', { name: 'Skill 名称' }), { target: { value: 'race' } });
  await fireEvent.click(screen.getByRole('button', { name: '创建 Skill' }));
  await waitFor(() => expect(skillApi.list).toHaveBeenCalledTimes(2));
  await view.rerender({ projectKey: KEY_B, yaml, selectedAgent: 'alpha', onYamlChange });
  pendingA.resolve([]);
  await waitFor(() => expect(skillApi.list).toHaveBeenCalledWith(KEY_B));
  expect(skillApi.read).not.toHaveBeenCalledWith(KEY_B, 'race/SKILL.md');
  expect(screen.queryByText('已创建 race')).not.toBeInTheDocument();
  expect(screen.queryByText('race/SKILL.md')).not.toBeInTheDocument();
});

test('retries only captured file deletion after YAML was durably committed', async () => {
  const yamlCommit = deferred<void>();
  const onYamlChange = vi.fn(() => yamlCommit.promise);
  vi.mocked(skillApi.remove).mockRejectedValueOnce(new Error('disk busy')).mockResolvedValueOnce();
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange });
  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  const trigger = screen.getByRole('button', { name: '删除 Skill' });
  trigger.focus();
  await fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: /确认删除/ });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus());
  await fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  expect(within(dialog).getByRole('button', { name: '确认删除' })).toHaveFocus();
  await fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus();
  await fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(trigger).toHaveFocus());
  await fireEvent.click(trigger);
  await fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(skillApi.remove).not.toHaveBeenCalled();
  yamlCommit.resolve();
  expect(await screen.findByRole('button', { name: '重试删除文件' })).toBeInTheDocument();
  expect(skillApi.remove).toHaveBeenCalledWith(KEY_A, 'demo', true);
  await fireEvent.click(screen.getByRole('button', { name: '重试删除文件' }));
  await waitFor(() => expect(skillApi.remove).toHaveBeenCalledTimes(2));
  expect(onYamlChange).toHaveBeenCalledTimes(1);
});

test('preserves unrelated YAML edits made while delete confirmation is open', async () => {
  const onYamlChange = vi.fn();
  const view = render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange });
  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除 Skill' }));
  await view.rerender({ projectKey: KEY_A, yaml: `${yaml}\nx-concurrent: preserved\n`, selectedAgent: 'alpha', onYamlChange });
  await fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(onYamlChange).toHaveBeenCalled());
  expect(onYamlChange.mock.calls[0][0]).toContain('x-concurrent: preserved');
});

test('refreshes changed references and requires a second delete confirmation', async () => {
  const onYamlChange = vi.fn();
  const view = render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange });
  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除 Skill' }));
  const changedYaml = `${yaml}\n  gamma:\n    skills:\n      - name: demo\n        source: file\n        path: ./skills/demo\n`;
  await view.rerender({ projectKey: KEY_A, yaml: changedYaml, selectedAgent: 'alpha', onYamlChange });
  await fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(onYamlChange).not.toHaveBeenCalled();
  expect(skillApi.remove).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: /确认删除/ })).toHaveTextContent('gamma');
  await fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(onYamlChange).toHaveBeenCalledTimes(1));
  expect(onYamlChange.mock.calls[0][0]).not.toContain('./skills/demo');
});

test('invalidates an open delete dialog when the project changes', async () => {
  const view = render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  await fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  await fireEvent.click(screen.getByRole('button', { name: '删除 Skill' }));
  await view.rerender({ projectKey: KEY_B, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('exposes selected/editor semantics and isolates modal background accessibly', async () => {
  render(SkillPanel, { projectKey: KEY_A, yaml, selectedAgent: 'alpha', onYamlChange: vi.fn() });
  const skillButton = await screen.findByRole('button', { name: 'demo' });
  await fireEvent.click(skillButton);
  expect(skillButton).toHaveAttribute('aria-current', 'true');
  const editor = await screen.findByRole('textbox', { name: 'demo/SKILL.md' });
  expect(editor).toHaveAttribute('aria-label', 'demo/SKILL.md');
  await fireEvent.click(screen.getByRole('button', { name: '删除 Skill' }));
  const panel = document.querySelector('.skill-panel');
  expect(panel).toHaveAttribute('inert');
  expect(panel).toHaveAttribute('aria-hidden', 'true');
  const dialog = screen.getByRole('dialog', { name: /确认删除/ });
  expect(dialog).toHaveAttribute('aria-describedby');
  const description = dialog.getAttribute('aria-describedby');
  expect(description).not.toBeNull();
  expect(document.getElementById(description!)).toHaveTextContent('alpha');
});
