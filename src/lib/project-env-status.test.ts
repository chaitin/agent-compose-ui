import { afterEach, expect, test, vi } from 'vitest';
import { getProjectEnvStatus } from './project-env-status';

afterEach(() => vi.unstubAllGlobals());

test('reads pending sync state without sending project mutations', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{"pendingSync":true}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetcher);

  await expect(getProjectEnvStatus('project/a')).resolves.toEqual({ pendingSync: true });
  expect(fetcher).toHaveBeenCalledWith(
    '/api/project-env/status?project_id=project%2Fa',
    expect.objectContaining({ method: 'GET', headers: { Accept: 'application/json' } }),
  );
});
