import { describe, expect, test } from 'vitest';
import { sandboxResumeErrorMessage } from './sandbox-resume-error';

describe('sandboxResumeErrorMessage', () => {
  test.each([
    'docker runtime state for stopped sandbox abc is missing; refusing to recreate it during resume',
    'only canonical legacy UUID sandboxes may be reconstructed',
  ])('maps a missing runtime error to a deleted Sandbox message', (message) => {
    expect(sandboxResumeErrorMessage(new Error(message))).toBe('该 Sandbox 已被删除，无法恢复');
  });

  test('preserves an unrelated resume error', () => {
    expect(sandboxResumeErrorMessage(new Error('permission denied'))).toBe('permission denied');
  });

  test('uses the resume fallback when no message is available', () => {
    expect(sandboxResumeErrorMessage({})).toBe('恢复 Sandbox 失败');
  });
});
