import { expect, test } from 'bun:test';
import { ImageAvailabilityStatus, ImageStoreKind } from '../gen/agentcompose/v2/agentcompose_pb';
import { formatImageBytes, formatImagePlatform, imageAvailabilityLabel, imageStoreLabel } from './images';

test('formats image sizes using binary units', () => {
  expect(formatImageBytes(0n)).toBe('0 B');
  expect(formatImageBytes(1536n)).toBe('1.5 KiB');
  expect(formatImageBytes(5n * 1024n * 1024n)).toBe('5 MiB');
});

test('formats an image platform without empty segments', () => {
  expect(formatImagePlatform({ os: 'linux', architecture: 'amd64', variant: '' })).toBe('linux/amd64');
  expect(formatImagePlatform(undefined)).toBe('后端未提供');
});

test('maps image enums to concise Chinese labels', () => {
  expect(imageStoreLabel(ImageStoreKind.DOCKER_DAEMON)).toBe('Docker daemon');
  expect(imageStoreLabel(ImageStoreKind.OCI_CACHE)).toBe('OCI 缓存');
  expect(imageAvailabilityLabel(ImageAvailabilityStatus.AVAILABLE)).toBe('可用');
  expect(imageAvailabilityLabel(ImageAvailabilityStatus.ERROR)).toBe('错误');
});
