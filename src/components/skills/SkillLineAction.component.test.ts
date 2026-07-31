import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import SkillLineAction from './SkillLineAction.svelte';

test.each([
  ['add', '添加 Skill'],
  ['manage', '管理 Skill'],
  ['repair', '修正 Skill'],
] as const)('renders the %s YAML action', async (state, label) => {
  const onOpen = vi.fn();
  render(SkillLineAction, { state, agentName: 'investigator', onOpen });

  const button = screen.getByRole('button', { name: `${label}：investigator` });
  if (state === 'repair') expect(button).toHaveClass('warning');
  await fireEvent.click(button);
  expect(onOpen).toHaveBeenCalledOnce();
});
