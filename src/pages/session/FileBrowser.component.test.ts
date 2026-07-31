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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('lists the parent directory and previews an initial workspace file', async () => {
  const execRequests: ExecRequest[] = [];
  mocks.execService.execStream.mockImplementation(async function* (request: ExecRequest) {
    execRequests.push(request);
    const chunk = execRequests.length === 1 ? 'f\treport.md\n' : 'runtime-prefix__AC_FILE_B';
    yield new ExecStreamResponse({
      eventType: ExecStreamEventType.OUTPUT,
      stream: StdioStream.STDOUT,
      chunk,
    });
    if (execRequests.length === 2) {
      yield new ExecStreamResponse({
        eventType: ExecStreamEventType.OUTPUT,
        stream: StdioStream.STDOUT,
        chunk: 'EGIN__cmVwb3J0IGJvZHk=__AC_FILE_END__runtime-result',
      });
    }
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
    command: { command: '/bin/sh', args: ['-c', "printf %s '__AC_FILE_BEGIN__'; head -c \"$1\" -- \"$2\" | base64 -w 0; printf %s '__AC_FILE_END__'", 'file-preview', String(512 * 1024 + 1), '/workspace/2026-07-21/report.md'] },
  });
  expect(await screen.findByDisplayValue('report body')).toBeTruthy();
});

test('does not preview the initial file after unmounting during its directory listing', async () => {
  const listing = deferred();
  const execRequests: ExecRequest[] = [];
  mocks.execService.execStream.mockImplementation(async function* (request: ExecRequest) {
    execRequests.push(request);
    if (execRequests.length === 1) await listing.promise;
  });

  const view = render(FileBrowser, {
    sandboxId: 'sandbox-1',
    initialFilePath: '/workspace/2026-07-21/report.md',
  });
  await waitFor(() => expect(execRequests).toHaveLength(1));

  view.unmount();
  listing.resolve();
  await listing.promise;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(execRequests).toHaveLength(1);
});
