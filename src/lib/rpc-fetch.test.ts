import { afterEach, describe, expect, test, vi } from 'vitest';
import { WatchSandboxRequest } from '../gen/agentcompose/v2/agentcompose_pb';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.resetModules();
});

describe('RPC streaming abort lifecycle', () => {
  test('keeps caller abort connected after streaming response headers arrive', async () => {
    let fetchSignal: AbortSignal | null | undefined;
    let responseController!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { responseController = controller; } }), {
        status: 200,
        headers: { 'Content-Type': 'application/connect+json' },
      });
    });
    const { sandboxService } = await import('./rpc');
    const caller = new AbortController();

    const events = sandboxService.watchSandbox(
      new WatchSandboxRequest({ sandboxId: 'sandbox-1' }),
      { signal: caller.signal },
    );
    const nextEvent = events[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    await Promise.resolve();

    caller.abort();
    const abortReachedFetch = fetchSignal?.aborted;
    responseController.close();
    await nextEvent.catch(() => undefined);

    expect(abortReachedFetch).toBe(true);
  });
});
