import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, test, vi } from 'vitest';
import {
  AgentSpec,
  BoxliteDriverSpec,
  DockerDriverSpec,
  DriverSpec,
  type InspectImageRequest,
  type ListCapabilitySetsRequest,
  ProjectSpec,
} from '../gen/agentcompose/v2/agentcompose_pb';
import { checkProjectDependencies } from './project-dependency-preflight';

function dockerAgent(name: string, image: string) {
  return new AgentSpec({
    name,
    image,
    driver: new DriverSpec({ docker: new DockerDriverSpec() }),
  });
}

function clients(inspectImage = vi.fn(async (_request: InspectImageRequest): Promise<unknown> => ({}))) {
  return {
    imageClient: { inspectImage },
    capabilityClient: { listCapabilitySets: vi.fn(async (_request: ListCapabilitySetsRequest): Promise<{
      capsets: Array<{ id: string; enabled: boolean }>;
    }> => ({ capsets: [] })) },
  };
}

describe('project dependency image preflight', () => {
  test('inspects each unique explicit Docker image once', async () => {
    const inspectImage = vi.fn(async (_request: InspectImageRequest): Promise<unknown> => ({}));
    const spec = new ProjectSpec({ agents: [
      dockerAgent('alpha', 'registry.example/guest:latest'),
      dockerAgent('beta', 'registry.example/guest:latest'),
      dockerAgent('gamma', 'registry.example/other:v1'),
      new AgentSpec({
        name: 'box',
        image: 'registry.example/box:v1',
        driver: new DriverSpec({ boxlite: new BoxliteDriverSpec() }),
      }),
      dockerAgent('default-image', ''),
    ] });

    await checkProjectDependencies({ spec, ...clients(inspectImage) });

    expect(inspectImage).toHaveBeenCalledTimes(2);
    expect(inspectImage.mock.calls.map(([request]) => request.imageRef).sort()).toEqual([
      'registry.example/guest:latest',
      'registry.example/other:v1',
    ]);
  });

  test('accepts the normalized driver name form', async () => {
    const inspectImage = vi.fn(async (_request: InspectImageRequest): Promise<unknown> => ({}));
    const spec = new ProjectSpec({ agents: [new AgentSpec({
      name: 'named-docker',
      image: 'registry.example/named:v1',
      driver: new DriverSpec({ name: 'docker' }),
    })] });

    await checkProjectDependencies({ spec, ...clients(inspectImage) });

    expect(inspectImage).toHaveBeenCalledTimes(1);
    expect(inspectImage.mock.calls[0]![0].imageRef).toBe('registry.example/named:v1');
  });

  test('blocks with the missing image and every affected agent', async () => {
    const inspectImage = vi.fn(async (_request: InspectImageRequest): Promise<unknown> => {
      throw new ConnectError('No such image', Code.NotFound);
    });
    const spec = new ProjectSpec({ agents: [
      dockerAgent('alpha', 'registry.example/missing:v1'),
      dockerAgent('beta', 'registry.example/missing:v1'),
    ] });

    await expect(checkProjectDependencies({ spec, ...clients(inspectImage) }))
      .rejects.toThrow(/registry\.example\/missing:v1.*alpha.*beta/s);
  });

  test('blocks when image availability cannot be checked', async () => {
    const inspectImage = vi.fn(async (_request: InspectImageRequest): Promise<unknown> => {
      throw new ConnectError('docker unavailable', Code.Unavailable);
    });
    const spec = new ProjectSpec({ agents: [dockerAgent('alpha', 'registry.example/guest:v1')] });

    await expect(checkProjectDependencies({ spec, ...clients(inspectImage) }))
      .rejects.toThrow(/无法检查.*registry\.example\/guest:v1.*docker unavailable/s);
  });
});

describe('project dependency capability-set preflight', () => {
  test('does not request capability sets when no agent declares IDs', async () => {
    const deps = clients();

    const result = await checkProjectDependencies({
      spec: new ProjectSpec({ agents: [new AgentSpec({ name: 'alpha' })] }),
      ...deps,
    });

    expect(deps.capabilityClient.listCapabilitySets).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
  });

  test('warns for missing and disabled sets without rejecting', async () => {
    const deps = clients();
    deps.capabilityClient.listCapabilitySets.mockResolvedValue({ capsets: [
      { id: 'enabled', enabled: true },
      { id: 'disabled', enabled: false },
      { id: 'ENABLED', enabled: true },
    ] });
    const spec = new ProjectSpec({ agents: [
      new AgentSpec({ name: 'alpha', capsetIds: ['enabled', 'missing', 'disabled'] }),
      new AgentSpec({ name: 'beta', capsetIds: ['missing', 'ENABLED'] }),
    ] });

    const result = await checkProjectDependencies({ spec, ...deps });

    expect(deps.capabilityClient.listCapabilitySets).toHaveBeenCalledTimes(1);
    expect(result.warnings).toEqual([
      'Agent alpha 引用的能力集 missing 不存在',
      'Agent alpha 引用的能力集 disabled 未启用',
      'Agent beta 引用的能力集 missing 不存在',
    ]);
  });

  test('turns capability service failure into one non-blocking warning', async () => {
    const deps = clients();
    deps.capabilityClient.listCapabilitySets.mockRejectedValue(new Error('gateway offline'));
    const spec = new ProjectSpec({ agents: [
      new AgentSpec({ name: 'alpha', capsetIds: ['core'] }),
    ] });

    const result = await checkProjectDependencies({ spec, ...deps });

    expect(result.warnings).toEqual(['能力集检查失败，已继续执行：gateway offline']);
  });
});
