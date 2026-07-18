import {
	batchStorageKey,
	createYamlRunBatch,
	readYamlRunBatch,
	replaceBatchAgent,
	writeYamlRunBatch,
	type YamlRunBatch
} from './yaml-run-batch';

type BatchStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type BatchUpdater = (batch: YamlRunBatch) => YamlRunBatch;

const normalizeProjectId = (projectId: string) => projectId.trim().replace(/^sha256:/, '');
const storageKeyPrefix = 'agent-compose:yaml-run:';
const fallbackStorage: BatchStorage = {
	getItem: () => null,
	setItem: () => undefined,
	removeItem: () => undefined
};

export function resolveBrowserStorage(getStorage: () => BatchStorage): BatchStorage {
	try {
		return getStorage();
	} catch {
		return fallbackStorage;
	}
}

export function createYamlRunBatchStore(storage: BatchStorage) {
	let batches = $state<Record<string, YamlRunBatch>>({});
	let loaded = new Set<string>();
	let generations = $state<Record<string, number>>({});
	let restored = new Set<string>();

	const compareBatch = (left: YamlRunBatch, right: YamlRunBatch) => {
		const byStartedAt = left.startedAt.localeCompare(right.startedAt);
		return byStartedAt || left.batchId.localeCompare(right.batchId);
	};

	const publish = (projectId: string, batch: YamlRunBatch | undefined) => {
		const next = { ...batches };
		if (batch) next[projectId] = batch;
		else delete next[projectId];
		batches = next;
		generations = { ...generations, [projectId]: (generations[projectId] ?? 0) + 1 };
	};

	const current = (projectId: string): YamlRunBatch | undefined => {
		const normalized = normalizeProjectId(projectId);
		if (!loaded.has(normalized)) {
			loaded.add(normalized);
			const stored = readYamlRunBatch(storage, normalized);
			if (stored) batches = { ...batches, [normalized]: stored };
		}
		return batches[normalized];
	};

	const update = (projectId: string, batchId: string, updater: BatchUpdater): boolean => {
		const normalized = normalizeProjectId(projectId);
		const batch = current(normalized);
		if (!batch || batch.projectId !== normalized || batch.batchId !== batchId) return false;
		const stored = readYamlRunBatch(storage, normalized);
		if (stored && stored.batchId !== batchId) {
			publish(normalized, stored);
			return false;
		}

		const updated = updater(batch);
		if (updated.projectId !== normalized || updated.batchId !== batchId) return false;
		writeYamlRunBatch(storage, updated);
		publish(normalized, updated);
		return true;
	};

	return {
		current,
		peek(projectId: string): YamlRunBatch | undefined {
			return batches[normalizeProjectId(projectId)];
		},

		restore(projectId: string): YamlRunBatch | undefined {
			const normalized = normalizeProjectId(projectId);
			const batch = current(normalized);
			if (!restored.has(normalized)) {
				restored.add(normalized);
				if (batch) this.reconcileInterrupted(normalized);
			}
			return current(normalized);
		},

		create(projectId: string, agents: Array<{ name: string; prompt: string }>, batchId?: string) {
			const normalized = normalizeProjectId(projectId);
			const batch = createYamlRunBatch(normalized, agents, new Date().toISOString(), batchId);
			loaded.add(normalized);
			writeYamlRunBatch(storage, batch);
			publish(normalized, batch);
			return batch;
		},

		update,

		reconcileInterrupted(projectId: string): boolean {
			const normalized = normalizeProjectId(projectId);
			const batch = current(normalized);
			if (!batch) return false;
			const interrupted = batch.agents.filter(
				(agent) => !agent.runId && ['waiting', 'starting', 'pending', 'running'].includes(agent.status)
			);
			if (interrupted.length === 0) return false;

			return update(normalized, batch.batchId, (value) =>
				interrupted.reduce(
					(next, agent) => replaceBatchAgent(next, agent.agentName, { status: 'start-interrupted' }),
					value
				)
			);
		},

		clearProject(projectId: string): void {
			const normalized = normalizeProjectId(projectId);
			loaded.add(normalized);
			try {
				storage.removeItem(batchStorageKey(normalized));
			} catch {
				// Persistence is best-effort (for example, storage may be unavailable).
			}
			publish(normalized, undefined);
		},

		generation(projectId: string): number {
			return generations[normalizeProjectId(projectId)] ?? 0;
		},

		applyStorageEvent(key: string, newValue: string | null): boolean {
			if (!key.startsWith(storageKeyPrefix)) return false;
			const projectId = key.slice(storageKeyPrefix.length);
			if (!projectId || projectId !== normalizeProjectId(projectId) || key !== batchStorageKey(projectId)) {
				return false;
			}

			loaded.add(projectId);
			if (newValue === null) {
				publish(projectId, undefined);
				return true;
			}

			const incoming = readYamlRunBatch({ getItem: () => newValue }, projectId);
			if (!incoming || incoming.projectId !== projectId) return false;
			const existing = current(projectId);
			if (existing && incoming.batchId !== existing.batchId && compareBatch(incoming, existing) <= 0) return false;
			publish(projectId, incoming);
			return true;
		}
	};
}

const hasBrowserWindow = typeof window !== 'undefined';
const browserStorage = hasBrowserWindow
	? resolveBrowserStorage(() => window.localStorage)
	: fallbackStorage;

export const yamlRunBatches = createYamlRunBatchStore(browserStorage);

if (hasBrowserWindow) {
	window.addEventListener('storage', (event) => {
		if ((event.storageArea && event.storageArea !== browserStorage) || event.key === null) return;
		yamlRunBatches.applyStorageEvent(event.key, event.newValue);
	});
}
