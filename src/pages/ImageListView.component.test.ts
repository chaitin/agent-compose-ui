import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import { Image, ImagePlatform, ImageStoreKind, InspectImageResponse } from '../gen/agentcompose/v2/agentcompose_pb';
import ImageListView from './ImageListView.svelte';

const mocks = vi.hoisted(() => ({ listImages: vi.fn(), inspectImage: vi.fn(), addToast: vi.fn() }));
vi.mock('../lib/rpc', () => ({ imageService: { listImages: mocks.listImages, inspectImage: mocks.inspectImage, removeImage: vi.fn() } }));
vi.mock('../lib/stores.svelte', () => ({ store: { addToast: mocks.addToast } }));

const finalImage = new Image({ imageId: 'sha256:final', imageRef: 'final:dev', store: ImageStoreKind.DOCKER_DAEMON, dangling: false, sizeBytes: 1024n });
const intermediateImage = new Image({ imageId: 'sha256:layer', imageRef: 'sha256:layer', store: ImageStoreKind.DOCKER_DAEMON, dangling: true, sizeBytes: 512n });
const appendedImage = new Image({ imageId: 'sha256:next', imageRef: 'next:dev', store: ImageStoreKind.DOCKER_DAEMON, dangling: false });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listImages.mockReset();
  mocks.inspectImage.mockReset();
  mocks.listImages
    .mockResolvedValueOnce({ images: [finalImage, intermediateImage], hasMore: true, nextOffset: 2 })
    .mockResolvedValueOnce({ images: [appendedImage], hasMore: false, nextOffset: 3 });
  mocks.inspectImage.mockResolvedValue(new InspectImageResponse({
    image: new Image({ ...finalImage, platform: new ImagePlatform({ os: 'linux', architecture: 'amd64' }), containerCount: 2n, labels: { purpose: 'test' } }),
    storeStatus: { endpoint: '/var/run/docker.sock' },
  }));
});

test('keeps pull available by default and only hides its entry when requested', async () => {
  const first = render(ImageListView);
  expect(await screen.findByRole('button', { name: '拉取镜像' })).toBeInTheDocument();
  first.unmount();

  render(ImageListView, { showPullAction: false });
  await screen.findByText('成品镜像');
  expect(screen.queryByRole('button', { name: '拉取镜像' })).not.toBeInTheDocument();
});

test('hides dangling images until showing intermediate layers is enabled', async () => {
  mocks.listImages.mockReset();
  mocks.listImages.mockResolvedValue({ images: [finalImage, intermediateImage], hasMore: false, nextOffset: 2 });
  render(ImageListView);

  expect(await screen.findByRole('button', { name: '展开镜像 final:dev' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '展开镜像 sha256:layer' })).toBeNull();
  expect(mocks.listImages.mock.calls[0][0]).toMatchObject({ all: false });

  await fireEvent.click(screen.getByRole('checkbox', { name: '显示中间层' }));
  expect(await screen.findByRole('button', { name: '展开镜像 sha256:layer' })).toBeInTheDocument();
  expect(mocks.listImages.mock.calls[1][0]).toMatchObject({ all: true });
});

test('hides known system images while keeping sandbox and build-base images visible', async () => {
  mocks.listImages.mockReset();
  mocks.listImages.mockResolvedValue({
    images: [
      new Image({ imageId: 'sha256:web', imageRef: 'agent-compose-ui:auth-final' }),
      new Image({ imageId: 'sha256:daemon', imageRef: 'ghcr.io/chaitin/agent-compose:latest' }),
      new Image({ imageId: 'sha256:scripts', imageRef: 'docker-scripts:latest' }),
      new Image({ imageId: 'sha256:guest', imageRef: 'ghcr.io/chaitin/agent-compose-guest:latest' }),
      new Image({ imageId: 'sha256:node', imageRef: 'node:22-alpine' }),
      new Image({ imageId: 'sha256:user', imageRef: 'reviewer:dev' }),
    ],
    hasMore: false,
    nextOffset: 6,
  });
  render(ImageListView);

  expect(await screen.findByRole('button', { name: '展开镜像 ghcr.io/chaitin/agent-compose-guest:latest' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '展开镜像 node:22-alpine' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '展开镜像 reviewer:dev' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '展开镜像 agent-compose-ui:auth-final' })).toBeNull();
  expect(screen.queryByRole('button', { name: '展开镜像 ghcr.io/chaitin/agent-compose:latest' })).toBeNull();
  expect(screen.queryByRole('button', { name: '展开镜像 docker-scripts:latest' })).toBeNull();
});

test('continues loading when a backend page contains only hidden system images', async () => {
  mocks.listImages.mockReset();
  mocks.listImages
    .mockResolvedValueOnce({
      images: [new Image({ imageId: 'sha256:web', imageRef: 'agent-compose-ui:auth-final' })],
      hasMore: true,
      nextOffset: 1,
    })
    .mockResolvedValueOnce({
      images: [new Image({ imageId: 'sha256:guest', imageRef: 'ghcr.io/chaitin/agent-compose-guest:latest' })],
      hasMore: false,
      nextOffset: 2,
    });
  render(ImageListView);

  expect(await screen.findByRole('button', { name: '展开镜像 ghcr.io/chaitin/agent-compose-guest:latest' })).toBeInTheDocument();
  expect(mocks.listImages).toHaveBeenCalledTimes(2);
  expect(mocks.listImages.mock.calls[0][0]).toMatchObject({ offset: 0 });
  expect(mocks.listImages.mock.calls[1][0]).toMatchObject({ offset: 1 });
});

test('labels image types and expands inspected details directly below the selected row', async () => {
  mocks.listImages.mockReset();
  mocks.listImages.mockResolvedValue({ images: [finalImage, intermediateImage], hasMore: false, nextOffset: 2 });
  render(ImageListView);

  await fireEvent.click(screen.getByRole('checkbox', { name: '显示中间层' }));
  expect(await screen.findByText('中间层')).toBeInTheDocument();
  expect(screen.getByText('成品镜像')).toBeInTheDocument();
  expect(screen.queryByText('平台')).toBeNull();
  const trigger = screen.getByRole('button', { name: '展开镜像 final:dev' });
  await fireEvent.click(trigger);

  const detail = await screen.findByTestId('image-detail-final:dev');
  expect(detail.previousElementSibling).toContainElement(screen.getByRole('button', { name: '收起镜像 final:dev' }));
  expect(within(detail).getByText('容器数')).toBeInTheDocument();
  expect(within(detail).getByText('2')).toBeInTheDocument();
  expect(within(detail).getByText('平台')).toBeInTheDocument();
  expect(within(detail).getByText('linux/amd64')).toBeInTheDocument();
  expect(detail.querySelector('.inspect-size')).toBeInTheDocument();
  expect(detail.querySelector('.inspect-size')).not.toBeVisible();

  await fireEvent.click(screen.getByRole('button', { name: '收起镜像 final:dev' }));
  expect(screen.queryByTestId('image-detail-final:dev')).toBeNull();
});

test('selects only currently loaded images and opens bulk removal for that selection', async () => {
  mocks.listImages.mockReset();
  mocks.listImages
    .mockResolvedValueOnce({ images: [finalImage, intermediateImage], hasMore: true, nextOffset: 2 })
    .mockResolvedValueOnce({ images: [finalImage, intermediateImage], hasMore: true, nextOffset: 2 })
    .mockResolvedValueOnce({ images: [appendedImage], hasMore: false, nextOffset: 3 });
  render(ImageListView);
  await fireEvent.click(screen.getByRole('checkbox', { name: '显示中间层' }));
  const selectAll = await screen.findByLabelText('选择当前已加载镜像');

  await fireEvent.click(selectAll);
  expect(screen.getByLabelText('选择镜像 final:dev')).toBeChecked();
  expect(screen.getByLabelText('选择镜像 sha256:layer')).toBeChecked();
  await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await waitFor(() => expect(screen.getByLabelText('选择镜像 next:dev')).not.toBeChecked());

  await fireEvent.click(screen.getByRole('button', { name: '删除所选（2）' }));
  expect(screen.getByRole('dialog', { name: '删除镜像' })).toBeInTheDocument();
  expect(within(screen.getByLabelText('待删除镜像')).getByText('final:dev')).toBeInTheDocument();
  expect(within(screen.getByLabelText('待删除镜像')).queryByText('next:dev')).toBeNull();
});

test('keeps inspection failures inline and retries without collapsing the row', async () => {
  mocks.inspectImage
    .mockRejectedValueOnce(new Error('daemon unavailable'))
    .mockResolvedValueOnce(new InspectImageResponse({ image: finalImage }));
  render(ImageListView);

  await fireEvent.click(await screen.findByRole('button', { name: '展开镜像 final:dev' }));
  expect(await screen.findByText('daemon unavailable')).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: '重试' }));

  expect(await screen.findByTestId('image-detail-final:dev')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '收起镜像 final:dev' })).toBeInTheDocument();
  expect(mocks.inspectImage).toHaveBeenCalledTimes(2);
});
