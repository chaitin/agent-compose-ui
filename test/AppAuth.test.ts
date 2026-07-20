import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.svelte';
import { getAuthStatus, login, requireLogin } from '../src/lib/auth';

const rpcMocks = vi.hoisted(() => ({ listProjects: vi.fn() }));

vi.mock('../src/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/auth')>();
  return { ...actual, getAuthStatus: vi.fn(), login: vi.fn() };
});

vi.mock('../src/lib/rpc', () => ({
  projectService: { listProjects: rpcMocks.listProjects },
  runService: {}, execService: {}, sandboxService: {}, sessionService: {}, kernelService: {},
  agentService: {}, loaderService: {}, dashboardService: {}, configService: {},
}));

vi.mock('../src/components/YamlEditor.svelte', async () => ({
  default: (await import('../src/components/Resizer.svelte')).default,
}));

describe('App authentication gate', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.mocked(getAuthStatus).mockReset();
    vi.mocked(login).mockReset();
    rpcMocks.listProjects.mockReset();
    rpcMocks.listProjects.mockResolvedValue({ projects: [], hasMore: false, nextOffset: 0 });
    sessionStorage.clear();
    history.replaceState(null, '', '/');
  });

  it('does not mount protected application components before auth status resolves', () => {
    vi.mocked(getAuthStatus).mockReturnValue(new Promise(() => {}));
    render(App);

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(rpcMocks.listProjects).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('正在检查访问权限');
  });

  it('shows login and restores pathname search and hash after success', async () => {
    history.replaceState(null, '', '/?sandboxTab=files#/project/demo');
    vi.mocked(getAuthStatus).mockResolvedValue({ enabled: true, loggedIn: false });
    vi.mocked(login).mockResolvedValue({ enabled: true, loggedIn: true, username: 'operator' });
    render(App);

    await fireEvent.input(await screen.findByLabelText('用户名'), { target: { value: 'operator' } });
    await fireEvent.input(screen.getByLabelText('密码'), { target: { value: 'secret' } });
    await fireEvent.click(screen.getByRole('button', { name: '进入控制台' }));

    await waitFor(() => expect(screen.getByText('Agent Compose').closest('nav')).toBeInTheDocument());
    expect(location.pathname + location.search + location.hash).toBe('/?sandboxTab=files#/project/demo');
    expect(sessionStorage.length).toBe(0);
  });

  it('disabled mode mounts the normal application without a login form', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ enabled: false, loggedIn: true });
    render(App);

    expect((await screen.findByText('Agent Compose')).closest('nav')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: '登录' })).not.toBeInTheDocument();
  });

  it('keeps protected children gated when status fails and retries', async () => {
    vi.mocked(getAuthStatus)
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce({ enabled: true, loggedIn: false });
    render(App);

    expect(await screen.findByRole('alert')).toHaveTextContent('无法确认访问权限');
    expect(rpcMocks.listProjects).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('form', { name: '登录' })).toBeInTheDocument();
  });

  it('ignores a status completion from an unmounted older App instance', async () => {
    let resolveOld!: (status: { enabled: boolean; loggedIn: boolean }) => void;
    vi.mocked(getAuthStatus)
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ enabled: true, loggedIn: false });

    const oldApp = render(App);
    oldApp.unmount();
    render(App);
    expect(await screen.findByRole('form', { name: '登录' })).toBeInTheDocument();

    resolveOld({ enabled: false, loggedIn: true });
    await Promise.resolve();
    expect(screen.getByRole('form', { name: '登录' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('continues authentication when sessionStorage throws', async () => {
    history.replaceState(null, '', '/workspace?tab=files#detail');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    vi.mocked(getAuthStatus).mockResolvedValue({ enabled: true, loggedIn: false });
    vi.mocked(login).mockResolvedValue({ enabled: true, loggedIn: true });
    render(App);

    await fireEvent.input(await screen.findByLabelText('用户名'), { target: { value: 'operator' } });
    await fireEvent.input(screen.getByLabelText('密码'), { target: { value: 'secret' } });
    await fireEvent.click(screen.getByRole('button', { name: '进入控制台' }));

    expect((await screen.findByText('Agent Compose')).closest('nav')).toBeInTheDocument();
    expect(location.pathname + location.search + location.hash).toBe('/workspace?tab=files#detail');
  });

  it('discards a malicious stored return target without navigating', async () => {
    sessionStorage.setItem('agent-compose.auth.return-target', '//evil.example/steal');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    vi.mocked(getAuthStatus).mockResolvedValue({ enabled: true, loggedIn: false });
    vi.mocked(login).mockResolvedValue({ enabled: true, loggedIn: true });
    render(App);

    await fireEvent.input(await screen.findByLabelText('用户名'), { target: { value: 'operator' } });
    await fireEvent.input(screen.getByLabelText('密码'), { target: { value: 'secret' } });
    await fireEvent.click(screen.getByRole('button', { name: '进入控制台' }));

    expect((await screen.findByText('Agent Compose')).closest('nav')).toBeInTheDocument();
    expect(location.pathname).toBe('/');
    expect(sessionStorage.getItem('agent-compose.auth.return-target')).toBeNull();
  });

  it('unmounts protected children on session expiry and restores the saved target after login', async () => {
    history.replaceState(null, '', '/workspace?tab=files#detail');
    vi.mocked(getAuthStatus).mockResolvedValue({ enabled: true, loggedIn: true, username: 'operator' });
    vi.mocked(login).mockResolvedValue({ enabled: true, loggedIn: true, username: 'operator' });
    render(App);

    expect((await screen.findByText('Agent Compose')).closest('nav')).toBeInTheDocument();
    expect(rpcMocks.listProjects).toHaveBeenCalled();

    requireLogin();

    expect(await screen.findByRole('form', { name: '登录' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('agent-compose.auth.return-target')).toBe('/workspace?tab=files#detail');

    history.replaceState(null, '', '/');
    await fireEvent.input(screen.getByLabelText('用户名'), { target: { value: 'operator' } });
    await fireEvent.input(screen.getByLabelText('密码'), { target: { value: 'secret' } });
    await fireEvent.click(screen.getByRole('button', { name: '进入控制台' }));

    await waitFor(() => expect(screen.getByText('Agent Compose').closest('nav')).toBeInTheDocument());
    expect(location.pathname + location.search + location.hash).toBe('/workspace?tab=files#detail');
  });

  it('broadcasts session expiry to every authenticated App when another App is already anonymous', async () => {
    let resolveAnonymous!: (status: { enabled: boolean; loggedIn: boolean }) => void;
    vi.mocked(getAuthStatus)
      .mockResolvedValueOnce({ enabled: true, loggedIn: true })
      .mockResolvedValueOnce({ enabled: true, loggedIn: true })
      .mockReturnValueOnce(new Promise((resolve) => { resolveAnonymous = resolve; }));

    render(App);
    render(App);
    render(App);
    await waitFor(() => expect(screen.getAllByText('Agent Compose')).toHaveLength(2));
    resolveAnonymous({ enabled: true, loggedIn: false });
    await waitFor(() => expect(screen.getAllByRole('form', { name: '登录' })).toHaveLength(1));

    requireLogin();

    await waitFor(() => expect(screen.getAllByRole('form', { name: '登录' })).toHaveLength(3));
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});
