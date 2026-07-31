import { render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import { ExecStreamEventType, ExecStreamResponse, StdioStream } from '../../gen/agentcompose/v2/agentcompose_pb';
import SessionTerminal from './SessionTerminal.svelte';

const mocks = vi.hoisted(() => ({ requests: [] as any[], onData: (_data: string) => {}, writes: [] as string[] }));

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  rows = 24; cols = 80;
  loadAddon() {} open() {} dispose() {}
  write(value: string) { mocks.writes.push(value); }
  writeln(value: string) { mocks.writes.push(value); }
  onData(callback: (data: string) => void) { mocks.onData = callback; return { dispose() {} }; }
  attachCustomKeyEventHandler() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('../../lib/rpc', () => ({ execService: {
  execStream: async function* (request: any) {
    mocks.requests.push(request);
    const isPwd = request.command?.command === '/bin/pwd';
    yield new ExecStreamResponse({ eventType: ExecStreamEventType.OUTPUT, stream: StdioStream.STDOUT, chunk: isPwd ? '/workspace\n' : 'ok\n' });
  },
} }));

beforeEach(() => { mocks.requests = []; mocks.writes = []; mocks.onData = () => {}; });

test('connects through browser-compatible ExecStream and discovers the Sandbox cwd', async () => {
  render(SessionTerminal, { sandboxId: 'sandbox-1' });

  await waitFor(() => expect(mocks.requests).toHaveLength(1));
  expect(mocks.requests[0]).toMatchObject({ target: { case: 'sandboxId', value: 'sandbox-1' }, command: { command: '/bin/pwd' } });
  expect(screen.getByText('已连接')).toBeTruthy();
  expect(mocks.writes.join('')).toContain('/workspace');
});

test('executes an entered line with ExecStream instead of ExecAttach', async () => {
  render(SessionTerminal, { sandboxId: 'sandbox-1' });
  await waitFor(() => expect(mocks.requests).toHaveLength(1));

  mocks.onData('echo ok\r');
  await waitFor(() => expect(mocks.requests).toHaveLength(2));
  expect(mocks.requests[1]).toMatchObject({
    target: { case: 'sandboxId', value: 'sandbox-1' }, command: { command: '/bin/sh', args: ['-lc', 'echo ok'] }, cwd: '/workspace',
  });
  expect(mocks.writes.join('')).toContain('ok\r\n');
});

test('keeps cd state in the frontend console', async () => {
  render(SessionTerminal, { sandboxId: 'sandbox-1' });
  await waitFor(() => expect(mocks.requests).toHaveLength(1));

  mocks.onData('cd /tmp\r');
  await waitFor(() => expect(mocks.requests).toHaveLength(2));
  expect(mocks.requests[1]).toMatchObject({ command: { args: expect.arrayContaining(['/tmp']) } });
});
