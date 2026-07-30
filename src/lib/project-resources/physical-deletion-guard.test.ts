import { expect, test } from 'vitest';
import { beginManagedVolumeDeletion, managedVolumeDeletionGuard } from './physical-deletion-guard';

test('blocks applies only while a registered physical deletion is active', () => {
  const release = beginManagedVolumeDeletion('ws_0123456789abcdef0123456789abcdef', 'volume');
  expect(() => managedVolumeDeletionGuard.assertApplyAllowed()).toThrow(/正在删除/);
  release(); release();
  expect(() => managedVolumeDeletionGuard.assertApplyAllowed()).not.toThrow();
});
