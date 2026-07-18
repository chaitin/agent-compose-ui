import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import { Image, ImageStoreKind, RemoveImageResponse } from '../gen/agentcompose/v2/agentcompose_pb';
import RemoveImageModal from './RemoveImageModal.svelte';

const mocks = vi.hoisted(() => ({ removeImage: vi.fn() }));
vi.mock('../lib/rpc', () => ({ imageService: { removeImage: mocks.removeImage } }));

const images = ['first', 'second', 'third'].map(name => new Image({
  imageId: `sha256:${name}`,
  imageRef: `${name}:dev`,
  store: ImageStoreKind.DOCKER_DAEMON,
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.confirm = vi.fn(() => true);
  mocks.removeImage.mockImplementation(async (request: { imageRef: string }) => {
    if (request.imageRef === 'second:dev') throw new Error('image is in use');
    return new RemoveImageResponse({ deletedIds: [`sha256:${request.imageRef.split(':')[0]}`] });
  });
});

test('continues bulk deletion after a failure and retries only failed images', async () => {
  const oncomplete = vi.fn();
  render(RemoveImageModal, { props: { images, onclose: vi.fn(), oncomplete } });

  await fireEvent.click(screen.getByLabelText('强制删除'));
  await fireEvent.click(screen.getByRole('button', { name: '确认删除 3 个镜像' }));

  await waitFor(() => expect(mocks.removeImage).toHaveBeenCalledTimes(3));
  expect(screen.getByText('成功 2')).toBeInTheDocument();
  expect(screen.getByText('失败 1')).toBeInTheDocument();
  expect(screen.getByText('image is in use').closest('.outcome')).toHaveTextContent('second:dev');
  expect(oncomplete).toHaveBeenCalledOnce();
  expect(mocks.removeImage.mock.calls.every(([request]) => request.force === true)).toBe(true);

  mocks.removeImage.mockResolvedValueOnce(new RemoveImageResponse({ deletedIds: ['sha256:second'] }));
  await fireEvent.click(screen.getByRole('button', { name: '重试失败项（1）' }));

  await waitFor(() => expect(mocks.removeImage).toHaveBeenCalledTimes(4));
  expect(mocks.removeImage.mock.calls[3][0].imageRef).toBe('second:dev');
  expect(screen.getByText('成功 3')).toBeInTheDocument();
  expect(screen.getByText('失败 0')).toBeInTheDocument();
});
