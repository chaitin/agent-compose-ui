import { describe, expect, test } from 'bun:test';
import { deduplicateProjectEntries } from './projects';

function project(projectId, name = 'tech-radar') {
  return {
    summary: { projectId, name, sourcePath: '/projects/tech-radar/agent-compose.yml' },
    source: { composePath: '/projects/tech-radar/agent-compose.yml', projectDir: '' },
    yamlContent: '',
    dirty: false,
  };
}

describe('deduplicateProjectEntries', () => {
  test('treats legacy sha256-prefixed and current IDs as the same project', () => {
    const hash = '31ccba9d49e51ff2093b2a9ec7f69d6676f72a1e952569cf99c567007d19581f';

    const result = deduplicateProjectEntries([
      project(`sha256:${hash}`),
      project(hash),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].summary.projectId).toBe(hash);
  });

  test('keeps a legacy project when no current ID exists', () => {
    const legacy = project('sha256:legacy');

    expect(deduplicateProjectEntries([legacy])).toEqual([legacy]);
  });

  test('refreshes an existing project with the latest summary and spec hash', () => {
    const stale = project('project-1');
    stale.summary.specHash = '';
    const refreshed = project('project-1');
    refreshed.summary.specHash = 'sha256:current';
    refreshed.summary.currentRevision = 5n;

    expect(deduplicateProjectEntries([stale, refreshed])).toEqual([refreshed]);
  });

  test('does not merge unrelated projects with the same name', () => {
    const result = deduplicateProjectEntries([
      project('first'),
      project('second'),
    ]);

    expect(result).toHaveLength(2);
  });
});
