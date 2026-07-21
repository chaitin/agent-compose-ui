import { render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  ExecStreamEventType,
  ExecStreamResponse,
  StdioStream,
  type ExecRequest,
} from '../../gen/agentcompose/v2/agentcompose_pb';
import FileBrowser from './FileBrowser.svelte';

const mocks = vi.hoisted(() => ({
  execService: { execStream: vi.fn() },
}));

vi.mock('../../lib/rpc', () => mocks);

beforeEach(() => {
  vi.clearAllMocks();
});

test('lists the parent directory and previews an initial workspace file', async () => {
  const execRequests: ExecRequest[] = [];
  mocks.execService.execStream.mockImplementation(async function* (request: ExecRequest) {
    execRequests.push(request);
    const chunk = execRequests.length === 1 ? 'f\treport.md\n' : 'report body';
    yield new ExecStreamResponse({
      eventType: ExecStreamEventType.OUTPUT,
      stream: StdioStream.STDOUT,
      chunk,
    });
  });

  render(FileBrowser, {
    sandboxId: 'sandbox-1',
    initialFilePath: '/workspace/2026-07-21/report.md',
  });

  await waitFor(() => expect(execRequests).toHaveLength(2));
  expect(execRequests[0]).toMatchObject({
    command: { command: '/usr/bin/find', args: ['/workspace/2026-07-21', '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\t%f\n'] },
  });
  expect(execRequests[1]).toMatchObject({
    command: { command: '/bin/cat', args: ['--', '/workspace/2026-07-21/report.md'] },
  });
  expect(await screen.findByDisplayValue('report body')).toBeTruthy();
});
