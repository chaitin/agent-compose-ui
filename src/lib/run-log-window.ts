export type RunLogScope = 'tail-100' | 'tail-500' | 'all';

export const RUN_LOG_TAIL_LINES = { 'tail-100': 100, 'tail-500': 500, all: 0 } as const;

export interface RunLogWindowChunk {
  data: string;
  createdAt: string;
  offset: bigint;
  sequence: number;
}

export interface RunLogWindowState {
  scope: RunLogScope;
  tailLines: number;
  fullyLoaded: boolean;
  chunks: RunLogWindowChunk[];
  pendingLiveChunks: RunLogWindowChunk[];
  loadingScope?: RunLogScope;
}

type IncomingRunLogChunk = Omit<RunLogWindowChunk, 'createdAt' | 'sequence'> &
  Partial<Pick<RunLogWindowChunk, 'createdAt' | 'sequence'>>;

export function initialRunLogWindow(): RunLogWindowState {
  return {
    scope: 'tail-100',
    tailLines: RUN_LOG_TAIL_LINES['tail-100'],
    fullyLoaded: false,
    chunks: [],
    pendingLiveChunks: [],
  };
}

export function nextRunLogScope(scope: RunLogScope): RunLogScope {
  if (scope === 'tail-100') return 'tail-500';
  return 'all';
}

export function beginRunLogLoad(state: RunLogWindowState, scope: RunLogScope): RunLogWindowState {
  return { ...state, loadingScope: scope };
}

export function replaceRunLogWindow(
  state: RunLogWindowState,
  scope: RunLogScope,
  chunks: IncomingRunLogChunk[],
): RunLogWindowState {
  return {
    ...state,
    scope,
    tailLines: RUN_LOG_TAIL_LINES[scope],
    fullyLoaded: scope === 'all',
    chunks: mergeChunks(chunks, state.pendingLiveChunks),
    pendingLiveChunks: [],
    loadingScope: undefined,
  };
}

export function appendLiveRunLogChunk(
  state: RunLogWindowState,
  chunk: IncomingRunLogChunk,
): RunLogWindowState {
  const normalized = normalizeChunk(chunk, state.chunks.length + state.pendingLiveChunks.length);
  return {
    ...state,
    chunks: mergeChunks(state.chunks, [normalized]),
    pendingLiveChunks: state.loadingScope
      ? mergeChunks(state.pendingLiveChunks, [normalized])
      : state.pendingLiveChunks,
  };
}

function mergeChunks(
  baseline: IncomingRunLogChunk[],
  additions: IncomingRunLogChunk[],
): RunLogWindowChunk[] {
  const byOffset = new Map<bigint, RunLogWindowChunk>();
  baseline.forEach((chunk, index) => byOffset.set(chunk.offset, normalizeChunk(chunk, index)));
  additions.forEach((chunk, index) => byOffset.set(chunk.offset, normalizeChunk(chunk, baseline.length + index)));
  return [...byOffset.values()].sort(compareChunks);
}

function normalizeChunk(chunk: IncomingRunLogChunk, fallbackSequence: number): RunLogWindowChunk {
  return {
    data: chunk.data,
    createdAt: chunk.createdAt ?? '',
    offset: chunk.offset,
    sequence: chunk.sequence ?? fallbackSequence,
  };
}

function compareChunks(left: RunLogWindowChunk, right: RunLogWindowChunk): number {
  if (left.offset < right.offset) return -1;
  if (left.offset > right.offset) return 1;
  return left.sequence - right.sequence;
}
