import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import SkillLineAction from './SkillLineAction.svelte';
import ScriptLineActions from '../scripts/ScriptLineActions.svelte';

test.each([
  ['add', '添加 Skill'],
  ['manage', '配置 Skill'],
  ['repair', '修正 Skill'],
] as const)('renders the %s YAML action', async (state, label) => {
  const onOpen = vi.fn();
  render(SkillLineAction, { state, agentName: 'investigator', onOpen });

  const button = screen.getByRole('button', { name: `${label}：investigator` });
  if (state === 'repair') expect(button).toHaveClass('warning');
  await fireEvent.click(button);
  expect(onOpen).toHaveBeenCalledOnce();
});

test('matches the extract-to-file action typography and control geometry', () => {
  render(ScriptLineActions, {
    kind: 'inline', empty: false, fileExists: false,
    onMode: vi.fn(), onExtract: vi.fn(), onReference: vi.fn(), onInline: vi.fn(),
  });
  render(SkillLineAction, { state: 'manage', agentName: 'investigator', onOpen: vi.fn() });

  const extractStyle = getComputedStyle(screen.getByRole('button', { name: /提取到文件/ }));
  const skillStyle = getComputedStyle(screen.getByRole('button', { name: '配置 Skill：investigator' }));
  expect(skillStyle.padding).toBe(extractStyle.padding);
  expect(skillStyle.borderRadius).toBe(extractStyle.borderRadius);
  expect(skillStyle.fontSize).toBe(extractStyle.fontSize);
  expect(skillStyle.fontWeight).toBe(extractStyle.fontWeight);
});
