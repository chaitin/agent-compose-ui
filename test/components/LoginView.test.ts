import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginView from '../../src/components/LoginView.svelte';
import { login } from '../../src/lib/auth';

vi.mock('../../src/lib/auth', () => ({ login: vi.fn() }));

describe('LoginView', () => {
  beforeEach(() => vi.mocked(login).mockReset());

  it('submits credentials and does not persist the password', async () => {
    vi.mocked(login).mockResolvedValue({ enabled: true, loggedIn: true, username: 'operator' });
    const onAuthenticated = vi.fn();
    render(LoginView, { onAuthenticated });

    await fireEvent.input(screen.getByLabelText('用户名'), { target: { value: 'operator' } });
    await fireEvent.input(screen.getByLabelText('密码'), { target: { value: 'secret-value' } });
    await fireEvent.click(screen.getByRole('button', { name: '进入控制台' }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(login).toHaveBeenCalledWith('operator', 'secret-value');
    expect(JSON.stringify(sessionStorage)).not.toContain('secret-value');
  });

  it('shows a useful error and keeps the form available after rejection', async () => {
    vi.mocked(login).mockResolvedValue({ enabled: true, loggedIn: false });
    render(LoginView, { onAuthenticated: vi.fn() });

    await fireEvent.input(screen.getByLabelText('用户名'), { target: { value: 'operator' } });
    await fireEvent.input(screen.getByLabelText('密码'), { target: { value: 'wrong' } });
    await fireEvent.click(screen.getByRole('button', { name: '进入控制台' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码错误');
    expect(screen.getByRole('button', { name: '进入控制台' })).toBeEnabled();
  });
});
