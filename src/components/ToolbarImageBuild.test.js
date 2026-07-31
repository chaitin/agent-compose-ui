import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(new URL('./Toolbar.svelte', import.meta.url), 'utf8');

describe('Toolbar YAML image build confirmation', () => {
  test('creates build plans from the frozen prepared YAML and daemon source path', () => {
    expect(source).toMatch(/createProjectImageBuildPlans/);
    expect(source).toMatch(/changedBuildAgentNames/);
    expect(source).toMatch(/GetProjectRequest/);
    expect(source).toMatch(/includeSpec:\s*true/);
    expect(source).toMatch(/preview\.prepared\.yamlText/);
    expect(source).toMatch(/summary\.sourcePath/);
  });

  test('offers an explicit build-or-skip choice and per-agent selection', () => {
    expect(source).toMatch(/构建 YAML 中配置的镜像/);
    expect(source).toMatch(/仅应用配置，不构建镜像/);
    expect(source).toMatch(/selectedBuildAgents/);
    expect(source).toMatch(/本次构建选项/);
    expect(source).toMatch(/不使用缓存/);
    expect(source).toMatch(/拉取最新基础镜像/);
  });

  test('shows the real phase rail and stream progress', () => {
    expect(source).toMatch(/构建镜像/);
    expect(source).toMatch(/应用配置/);
    expect(source).toMatch(/启动运行/);
    expect(source).toMatch(/buildResults/);
    expect(source).toMatch(/result\.stream\.lines/);
  });

  test('builds before applying and preserves the preview on build failure', () => {
    expect(source).toMatch(/async function confirmBuildAndApply/);
    expect(source).toMatch(/await runProjectImageBuildPlans/);
    expect(source).toMatch(/await confirmApply/);
    const orchestration = source.slice(source.indexOf('async function confirmBuildAndApply'), source.indexOf('function buildActionLabel'));
    expect(orchestration.indexOf('await runProjectImageBuildPlans')).toBeLessThan(orchestration.lastIndexOf('await confirmApply'));
    expect(source).toMatch(/ProjectImageBuildRunError/);
    expect(source).toMatch(/pendingApply/);
  });
});
