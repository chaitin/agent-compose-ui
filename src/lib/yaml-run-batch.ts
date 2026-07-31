export type BatchAgentStatus =
	| 'waiting'
	| 'starting'
	| 'pending'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'canceled'
	| 'start-failed'
	| 'start-interrupted';

export interface YamlRunBatchAgent {
	agentName: string;
	prompt: string;
	runId: string;
	status: BatchAgentStatus;
	startError: string;
}

export interface YamlRunBatch {
	version: 1;
	batchId: string;
	projectId: string;
	startedAt: string;
	completedAt: string;
	agents: YamlRunBatchAgent[];
}

const statuses = new Set<BatchAgentStatus>([
	'waiting',
	'starting',
	'pending',
	'running',
	'succeeded',
	'failed',
	'canceled',
	'start-failed',
	'start-interrupted'
]);

const completedStatuses = new Set<BatchAgentStatus>([
	'succeeded',
	'failed',
	'canceled',
	'start-failed',
	'start-interrupted'
]);

const normalizeProjectId = (projectId: string) => projectId.trim().replace(/^sha256:/, '');

function createBatchId(): string {
	if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();

	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const batchStorageKey = (projectId: string) =>
	`agent-compose:yaml-run:${normalizeProjectId(projectId)}`;

export function createYamlRunBatch(
	projectId: string,
	agents: Array<{ name: string; prompt: string }>,
	startedAt = new Date().toISOString(),
	batchId: string = createBatchId()
): YamlRunBatch {
	return {
		version: 1,
		batchId,
		projectId: normalizeProjectId(projectId),
		startedAt,
		completedAt: '',
		agents: agents.map((agent) => ({
			agentName: agent.name,
			prompt: agent.prompt,
			runId: '',
			status: 'waiting',
			startError: ''
		}))
	};
}

export function replaceBatchAgent(
	batch: YamlRunBatch,
	agentName: string,
	patch: Partial<YamlRunBatchAgent>
): YamlRunBatch {
	const agents = batch.agents.map((agent) =>
		agent.agentName === agentName ? { ...agent, ...patch } : agent
	);
	const completed = agents.length > 0 && agents.every((agent) => completedStatuses.has(agent.status));
	return {
		...batch,
		agents,
		completedAt: completed ? batch.completedAt || new Date().toISOString() : ''
	};
}

export function batchStats(batch?: YamlRunBatch): {
	total: number;
	completed: number;
	active: boolean;
} {
	if (!batch) return { total: 0, completed: 0, active: false };
	const completed = batch.agents.filter((agent) => completedStatuses.has(agent.status)).length;
	return {
		total: batch.agents.length,
		completed,
		active: batch.agents.length > 0 && completed < batch.agents.length
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function decodeBatch(value: unknown, projectId: string): YamlRunBatch | undefined {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.agents)) return undefined;
	if (
		typeof value.batchId !== 'string' ||
		typeof value.projectId !== 'string' ||
		typeof value.startedAt !== 'string' ||
		typeof value.completedAt !== 'string' ||
		normalizeProjectId(value.projectId) !== normalizeProjectId(projectId)
	) {
		return undefined;
	}

	const names = new Set<string>();
	for (const agent of value.agents) {
		if (
			!isRecord(agent) ||
			typeof agent.agentName !== 'string' ||
			agent.agentName.length === 0 ||
			names.has(agent.agentName) ||
			typeof agent.prompt !== 'string' ||
			typeof agent.runId !== 'string' ||
			typeof agent.startError !== 'string' ||
			typeof agent.status !== 'string' ||
			!statuses.has(agent.status as BatchAgentStatus)
		) {
			return undefined;
		}
		names.add(agent.agentName);
	}

	return value as unknown as YamlRunBatch;
}

export function readYamlRunBatch(
	storage: Pick<Storage, 'getItem'>,
	projectId: string
): YamlRunBatch | undefined {
	try {
		const stored = storage.getItem(batchStorageKey(projectId));
		return stored === null ? undefined : decodeBatch(JSON.parse(stored), projectId);
	} catch {
		return undefined;
	}
}

export function writeYamlRunBatch(
	storage: Pick<Storage, 'setItem'>,
	batch: YamlRunBatch
): void {
	try {
		storage.setItem(batchStorageKey(batch.projectId), JSON.stringify(batch));
	} catch {
		// Persistence is best-effort (for example, storage may be unavailable or full).
	}
}
