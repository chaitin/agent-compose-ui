import { describe, expect, test, vi } from 'vitest';
import { ProjectSpec } from '../gen/agentcompose/v2/agentcompose_pb';
import { yamlToSpec } from './yaml';
import { buildFileSources, checkProjectImageFiles } from './project-image-files';

function project(yaml: string): ProjectSpec {
  const parsed = yamlToSpec(yaml);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.spec;
}

function imageProject(context: string, dockerfile = 'Dockerfile'): ProjectSpec {
  return project(`name: demo
agents:
  writer:
    image: writer:dev
    build:
      context: ${JSON.stringify(context)}
      dockerfile: ${JSON.stringify(dockerfile)}
`);
}

describe('buildFileSources', () => {
  test('normalizes a relative context and keeps its Dockerfile path', () => {
    expect(buildFileSources(imageProject('./workspace/writer', 'docker/Dockerfile'))).toEqual([{
      agentName: 'writer',
      imageRef: 'writer:dev',
      context: 'workspace/writer',
      storagePath: 'workspace/writer',
      dockerfile: 'docker/Dockerfile',
      manageable: true,
      error: '',
    }]);
  });

  test('keeps absolute daemon contexts server-managed', () => {
    const [source] = buildFileSources(imageProject('/srv/build/writer'));
    expect(source).toMatchObject({ context: '/srv/build/writer', storagePath: '', manageable: false });
    expect(source.error).toContain('服务端');
  });

  test('keeps UNC daemon contexts server-managed', () => {
    const [source] = buildFileSources(imageProject('\\\\server\\share\\writer'));
    expect(source).toMatchObject({
      context: '//server/share/writer',
      storagePath: '',
      manageable: false,
    });
    expect(source.error).toContain('服务端');
  });

  test('rejects the project root as a browser upload context', () => {
    const [source] = buildFileSources(imageProject('.'));
    expect(source).toMatchObject({ manageable: false });
    expect(source.error).toContain('根目录');
  });

  test('rejects relative contexts that escape storage', () => {
    const [source] = buildFileSources(imageProject('../writer'));
    expect(source).toMatchObject({ manageable: false });
    expect(source.error).toContain('..');
  });

  test.each(['/Dockerfile', '../Dockerfile', 'docker/../../Dockerfile'])(
    'rejects unsafe Dockerfile path %s',
    (dockerfile) => {
      const [source] = buildFileSources(imageProject('workspace/writer', dockerfile));
      expect(source).toMatchObject({ manageable: false });
      expect(source.error).toContain('Dockerfile');
    },
  );

  test('does not hide an unsafe Dockerfile behind a server-managed context', async () => {
    const [source] = buildFileSources(imageProject('/srv/build/writer', '../Dockerfile'));
    expect(source.error).toContain('Dockerfile');

    const [check] = await checkProjectImageFiles({
      spec: imageProject('/srv/build/writer', '../Dockerfile'),
      sourcePath: '/srv/agent-compose.yml',
    });
    expect(check.ready).toBe(false);
  });

  test('rejects a UNC Dockerfile even for a server-managed context', async () => {
    const spec = imageProject('/srv/build/writer', '\\\\server\\share\\Dockerfile');
    const [source] = buildFileSources(spec);
    expect(source.error).toContain('Dockerfile');

    const [check] = await checkProjectImageFiles({ spec, sourcePath: '/srv/agent-compose.yml' });
    expect(check.ready).toBe(false);
  });
});

describe('checkProjectImageFiles', () => {
  test('reports ready when the Dockerfile exists', async () => {
    const resolve = vi.fn().mockResolvedValue({ projectKey: 'demo', sourcePath: '/srv/agent-compose.yml', workspacePath: 'workspace' });
    const listFiles = vi.fn().mockResolvedValue({ files: [{ path: 'docker/Dockerfile', dir: false }] });

    const [check] = await checkProjectImageFiles({ spec: imageProject('workspace/writer', 'docker/Dockerfile'), sourcePath: '/srv/agent-compose.yml', resolve, listFiles });

    expect(check).toMatchObject({ agentName: 'writer', ready: true, error: '' });
    expect(resolve).toHaveBeenCalledWith('/srv/agent-compose.yml');
    expect(listFiles).toHaveBeenCalledWith('demo', 'workspace/writer');
  });

  test('reports a missing Dockerfile', async () => {
    const [check] = await checkProjectImageFiles({ spec: imageProject('workspace/writer'), sourcePath: '/srv/agent-compose.yml',
      resolve: vi.fn().mockResolvedValue({ projectKey: 'demo', workspacePath: 'workspace' }),
      listFiles: vi.fn().mockResolvedValue({ files: [{ path: 'README.md', dir: false }] }),
    });
    expect(check.ready).toBe(false);
    expect(check.message).toContain('Dockerfile');
  });

  test('reports directory read failures', async () => {
    const [check] = await checkProjectImageFiles({ spec: imageProject('workspace/writer'), sourcePath: '/srv/agent-compose.yml',
      resolve: vi.fn().mockResolvedValue({ projectKey: 'demo', workspacePath: 'workspace' }),
      listFiles: vi.fn().mockRejectedValue(new Error('storage offline')),
    });
    expect(check.ready).toBe(false);
    expect(check.message).toContain('storage offline');
  });

  test('treats absolute contexts as server-ready without browser file access', async () => {
    const resolve = vi.fn();
    const listFiles = vi.fn();
    const [check] = await checkProjectImageFiles({ spec: imageProject('/srv/build/writer'), sourcePath: '/srv/agent-compose.yml', resolve, listFiles });
    expect(check).toMatchObject({ ready: true, manageable: false, message: '' });
    expect(resolve).not.toHaveBeenCalled();
    expect(listFiles).not.toHaveBeenCalled();
  });

  test('checks and returns only selected agents', async () => {
    const spec = project(`name: demo
agents:
  writer:
    image: writer:dev
    build: { context: workspace/writer }
  reviewer:
    image: reviewer:dev
    build: { context: workspace/reviewer }
`);
    const listFiles = vi.fn().mockResolvedValue({ files: [{ path: 'Dockerfile', dir: false }] });

    const checks = await checkProjectImageFiles({
      spec,
      sourcePath: '/srv/agent-compose.yml',
      selectedAgentNames: new Set(['reviewer']),
      resolve: vi.fn().mockResolvedValue({ projectKey: 'demo', workspacePath: 'workspace' }),
      listFiles,
    });

    expect(checks.map((check) => check.agentName)).toEqual(['reviewer']);
    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(listFiles).toHaveBeenCalledWith('demo', 'workspace/reviewer');
  });
});
