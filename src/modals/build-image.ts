import { BuildImageRequest, ImageOperationStatus, ImagePlatform, type BuildImageEvent } from '../gen/agentcompose/v2/agentcompose_pb';

export class BuildImageFailedError extends Error {
  constructor(message: string) { super(message || '镜像构建失败'); this.name = 'BuildImageFailedError'; }
}

export interface BuildImageForm {
  contextDir: string; dockerfile: string; tagsText: string; buildArgsText: string; target: string;
  store: number; os: string; architecture: string; variant: string; noCache: boolean; pull: boolean;
}

export function createBuildImageRequest(form: BuildImageForm): BuildImageRequest {
  const buildArgs: Record<string, string> = {};
  for (const line of form.buildArgsText.split('\n').map((value) => value.trim()).filter(Boolean)) {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`构建参数格式错误：${line}`);
    buildArgs[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  const platform = form.os.trim() || form.architecture.trim() || form.variant.trim()
    ? new ImagePlatform({ os: form.os.trim(), architecture: form.architecture.trim(), variant: form.variant.trim() })
    : undefined;
  return new BuildImageRequest({
    contextDir: form.contextDir.trim(), dockerfile: form.dockerfile.trim(),
    tags: form.tagsText.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
    buildArgs, target: form.target.trim(), store: form.store, platform,
    noCache: form.noCache, pull: form.pull,
  });
}

export interface BuildStreamState {
  lines: Array<{ stage: string; message: string }>;
  warnings: string[];
  image?: BuildImageEvent['image'];
  imageRef: string;
  resolvedRef: string;
}

export async function consumeBuildImageEvents(
  stream: AsyncIterable<BuildImageEvent | Partial<BuildImageEvent>>,
  onUpdate: (state: BuildStreamState) => void,
): Promise<BuildStreamState> {
  const state: BuildStreamState = { lines: [], warnings: [], imageRef: '', resolvedRef: '' };
  for await (const event of stream) {
    if (event.stage || event.message) state.lines.push({ stage: event.stage || '', message: event.message || '' });
    state.warnings.push(...(event.warnings || []));
    if (event.image) state.image = event.image;
    if (event.imageRef) state.imageRef = event.imageRef;
    if (event.resolvedRef) state.resolvedRef = event.resolvedRef;
    onUpdate(state);
    if (event.status === ImageOperationStatus.FAILED) {
      throw new BuildImageFailedError(event.message || '镜像构建失败');
    }
  }
  return state;
}
