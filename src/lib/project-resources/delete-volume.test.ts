import { describe, expect, test } from 'vitest';
import { deleteManagedVolume, type DeleteManagedVolumeInput } from './delete-volume';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function callbacks(overrides: Partial<DeleteManagedVolumeInput> = {}): DeleteManagedVolumeInput {
  return {
    detachYaml: () => undefined,
    applyProject: async () => undefined,
    removeVolume: async () => undefined,
    ...overrides,
  };
}

describe('deleteManagedVolume', () => {
  test('awaits detach, apply, and remove in exact order and calls each once', async () => {
    const calls: string[] = [];
    const detach = deferred();
    const apply = deferred();
    const remove = deferred();
    const operation = deleteManagedVolume(callbacks({
      detachYaml: () => {
        calls.push('detach');
        return detach.promise;
      },
      applyProject: () => {
        calls.push('apply');
        return apply.promise;
      },
      removeVolume: () => {
        calls.push('remove');
        return remove.promise;
      },
    }));

    expect(calls).toEqual(['detach']);
    detach.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['detach', 'apply']);
    apply.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['detach', 'apply', 'remove']);
    remove.resolve();

    await expect(operation).resolves.toEqual({ status: 'removed' });
    expect(calls).toEqual(['detach', 'apply', 'remove']);
  });

  test('preserves a synchronous detach Error and never applies or removes', async () => {
    const failure = new Error('detach failed');
    const calls: string[] = [];

    await expect(deleteManagedVolume(callbacks({
      detachYaml: () => {
        calls.push('detach');
        throw failure;
      },
      applyProject: async () => { calls.push('apply'); },
      removeVolume: async () => { calls.push('remove'); },
    }))).rejects.toBe(failure);
    expect(calls).toEqual(['detach']);
  });

  test('normalizes a non-Error detach failure', async () => {
    await expect(deleteManagedVolume(callbacks({
      detachYaml: () => { throw 'detachment unavailable'; },
    }))).rejects.toEqual(new Error('detachment unavailable'));
  });

  test.each(['detach', 'apply'] as const)('normalizes a revoked Proxy %s failure without leaking instanceof TypeError', async (phase) => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const input = callbacks(phase === 'detach'
      ? { detachYaml: () => { throw proxy; } }
      : { applyProject: async () => { throw proxy; } });

    const failure = await deleteManagedVolume(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Volume deletion operation failed');
    expect((failure as Error).cause).toBe(proxy);
  });

  test('preserves apply failure after one detach and does not remove or roll back', async () => {
    const failure = new Error('apply failed');
    const calls: string[] = [];

    await expect(deleteManagedVolume(callbacks({
      detachYaml: () => { calls.push('detach'); },
      applyProject: async () => {
        calls.push('apply');
        throw failure;
      },
      removeVolume: async () => { calls.push('remove'); },
    }))).rejects.toBe(failure);
    expect(calls).toEqual(['detach', 'apply']);
  });

  test('returns pending cleanup on remove failure without reapplying or rolling back', async () => {
    const calls: string[] = [];
    const result = await deleteManagedVolume(callbacks({
      detachYaml: () => { calls.push('detach'); },
      applyProject: async () => { calls.push('apply'); },
      removeVolume: async () => {
        calls.push('remove');
        throw new Error('daemon refused removal');
      },
    }));

    expect(result).toEqual({
      status: 'detached_pending_cleanup',
      error: 'daemon refused removal',
    });
    expect(calls).toEqual(['detach', 'apply', 'remove']);
  });

  test.each([
    ['string', 'remove unavailable', 'remove unavailable'],
    ['null', null, 'Failed to remove volume'],
    ['object', { detail: 'do-not-stringify-this' }, 'Failed to remove volume'],
  ])('safely normalizes a %s remove failure', async (_label, thrown, message) => {
    const result = await deleteManagedVolume(callbacks({
      removeVolume: async () => { throw thrown; },
    }));
    expect(result).toEqual({ status: 'detached_pending_cleanup', error: message });
    if (result.status !== 'detached_pending_cleanup') throw new Error('expected cleanup result');
    expect(typeof result.error).toBe('string');
  });

  test('does not inspect arbitrary properties while normalizing a remove failure', async () => {
    const thrown = Object.defineProperty({}, 'message', {
      get: () => { throw new Error('getter must not run'); },
    });
    const result = await deleteManagedVolume(callbacks({
      removeVolume: async () => { throw thrown; },
    }));

    expect(result).toEqual({
      status: 'detached_pending_cleanup',
      error: 'Failed to remove volume',
    });
  });

  test('normalizes a revoked Proxy remove failure without leaking instanceof TypeError', async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const result = await deleteManagedVolume(callbacks({
      removeVolume: async () => { throw proxy; },
    }));

    expect(result).toEqual({
      status: 'detached_pending_cleanup',
      error: 'Failed to remove volume',
    });
  });

  test.each([
    ['throwing getter', (() => {
      const error = new Error('hidden');
      Object.defineProperty(error, 'message', { get: () => { throw new Error('getter failed'); } });
      return error;
    })()],
    ['object message', Object.assign(new Error(), { message: { secret: true } })],
    ['symbol message', Object.assign(new Error(), { message: Symbol('secret') })],
    ['empty message', new Error('')],
    ['whitespace-only message', new Error('   ')],
  ])('uses a primitive nonempty fallback for an Error with %s', async (_label, thrown) => {
    const result = await deleteManagedVolume(callbacks({
      removeVolume: async () => { throw thrown; },
    }));

    expect(result).toEqual({
      status: 'detached_pending_cleanup',
      error: 'Failed to remove volume',
    });
    if (result.status !== 'detached_pending_cleanup') throw new Error('expected cleanup result');
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  test('treats an AbortError during removal as pending cleanup', async () => {
    const aborted = new Error('removal aborted');
    aborted.name = 'AbortError';
    const result = await deleteManagedVolume(callbacks({
      removeVolume: async () => { throw aborted; },
    }));

    expect(result).toEqual({
      status: 'detached_pending_cleanup',
      error: 'removal aborted',
    });
  });
});
