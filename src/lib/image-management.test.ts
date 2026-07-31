import { describe, expect, test, vi } from 'vitest';
import { Image, ImageStoreKind, RemoveImageResponse } from '../gen/agentcompose/v2/agentcompose_pb';
import {
  imageDisplayRef,
  imageSelectionKey,
  isSystemImage,
  isSystemImageRef,
  removeImagesSequentially,
} from './image-management';

function image(imageId: string, imageRef: string): Image {
  return new Image({ imageId, imageRef, store: ImageStoreKind.DOCKER_DAEMON });
}

describe('image identity', () => {
  test('uses stable display fallbacks and includes the store in selection keys', () => {
    const tagged = new Image({ imageId: 'sha256:one', repoTags: ['demo:latest'], store: ImageStoreKind.DOCKER_DAEMON });
    const cached = new Image({ imageId: 'sha256:one', repoTags: ['demo:latest'], store: ImageStoreKind.OCI_CACHE });

    expect(imageDisplayRef(tagged)).toBe('demo:latest');
    expect(imageSelectionKey(tagged)).not.toBe(imageSelectionKey(cached));
  });

  test.each([
    ['agent-compose-ui:auth-final', true],
    ['ghcr.io/chaitin/agent-compose:latest', true],
    ['ghcr.io/chaitin/agent-compose@sha256:daemon', true],
    ['agent-compose-ui-scripts:latest', true],
    ['docker-scripts:latest', true],
    ['ghcr.io/chaitin/agent-compose-guest:latest', false],
    ['node:22-alpine', false],
    ['golang:1.24-alpine', false],
    ['nginx:1.27-alpine', false],
    ['oven/bun:1-alpine', false],
    ['reviewer:dev', false],
    ['', false],
  ])('classifies known system image reference %j as %j', (reference, expected) => {
    expect(isSystemImageRef(reference)).toBe(expected);
  });

  test('checks every image reference instead of only the display reference', () => {
    const tagged = new Image({
      imageId: 'sha256:system',
      imageRef: 'harmless:latest',
      repoTags: ['harmless:latest', 'agent-compose-ui:auth-final'],
      repoDigests: ['harmless@sha256:system'],
    });

    expect(isSystemImage(tagged)).toBe(true);
  });
});

describe('removeImagesSequentially', () => {
  test('continues after individual failures and preserves every outcome', async () => {
    const images = [image('sha256:first', 'first:dev'), image('sha256:second', 'second:dev'), image('sha256:third', 'third:dev')];
    const calls: string[] = [];
    const removeImage = vi.fn(async (request: { imageRef: string; force: boolean; pruneChildren: boolean }) => {
      calls.push(request.imageRef);
      expect(request.force).toBe(true);
      expect(request.pruneChildren).toBe(false);
      if (request.imageRef === 'second:dev') throw new Error('in use');
      return new RemoveImageResponse({ deletedIds: [`sha256:${request.imageRef.split(':')[0]}`] });
    });

    const results = await removeImagesSequentially({
      images,
      force: true,
      pruneChildren: false,
      client: { removeImage },
    });

    expect(calls).toEqual(['first:dev', 'second:dev', 'third:dev']);
    expect(results.map((result) => result.error)).toEqual(['', 'in use', '']);
    expect(results[0].response?.deletedIds).toEqual(['sha256:first']);
  });
});
