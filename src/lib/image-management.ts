import {
  RemoveImageRequest,
  type Image,
  type RemoveImageResponse,
} from '../gen/agentcompose/v2/agentcompose_pb';

export interface ImageRemovalClient {
  removeImage(request: RemoveImageRequest): Promise<RemoveImageResponse>;
}

export interface ImageRemovalResult {
  image: Image;
  imageRef: string;
  response?: RemoveImageResponse;
  error: string;
}

export function imageDisplayRef(image: Image): string {
  return image.imageRef || image.repoTags[0] || image.resolvedRef || image.imageId || '后端未提供';
}

export function imageSelectionKey(image: Image): string {
  return `${image.store}:${image.imageId}:${imageDisplayRef(image)}`;
}

const SYSTEM_IMAGE_REPOSITORIES = [
  'agent-compose-ui',
  'ghcr.io/chaitin/agent-compose',
  'agent-compose-ui-scripts',
  'docker-scripts',
] as const;

export function isSystemImageRef(reference: string): boolean {
  return SYSTEM_IMAGE_REPOSITORIES.some(repository =>
    reference === repository || reference.startsWith(`${repository}:`) || reference.startsWith(`${repository}@`),
  );
}

export function isSystemImage(image: Image): boolean {
  return [image.imageRef, image.resolvedRef, ...image.repoTags, ...image.repoDigests].some(isSystemImageRef);
}

export async function removeImagesSequentially(options: {
  images: Image[];
  force: boolean;
  pruneChildren: boolean;
  client: ImageRemovalClient;
}): Promise<ImageRemovalResult[]> {
  const results: ImageRemovalResult[] = [];
  for (const image of options.images) {
    const imageRef = imageDisplayRef(image);
    try {
      const response = await options.client.removeImage(new RemoveImageRequest({
        imageRef,
        store: image.store,
        force: options.force,
        pruneChildren: options.pruneChildren,
      }));
      results.push({ image, imageRef, response, error: '' });
    } catch (cause) {
      results.push({ image, imageRef, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return results;
}
