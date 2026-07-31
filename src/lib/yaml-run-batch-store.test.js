import { describe, expect, test } from 'bun:test';
import { createYamlRunBatch, replaceBatchAgent } from './yaml-run-batch';
import { createYamlRunBatchStore, resolveBrowserStorage } from './yaml-run-batch.svelte';

class MapStorage {
	values = new Map();

	getItem(key) {
		return this.values.get(key) ?? null;
	}

	setItem(key, value) {
		this.values.set(key, value);
	}

	removeItem(key) {
		this.values.delete(key);
	}
}

describe('yaml run batch store', () => {
	test('a new batch overwrites the old batch and stale updates are rejected', () => {
		const storage = new MapStorage();
		const batches = createYamlRunBatchStore(storage);
		const old = batches.create('p1', [{ name: 'a', prompt: '' }], 'old');
		const current = batches.create('p1', [{ name: 'b', prompt: '' }], 'new');

		expect(batches.update('p1', old.batchId, (value) => value)).toBe(false);
		expect(batches.current('p1')?.batchId).toBe(current.batchId);
	});

	test('refresh marks agents without run ids as interrupted without restarting them', () => {
		const storage = new MapStorage();
		const batches = createYamlRunBatchStore(storage);
		const batch = batches.create('p1', [{ name: 'a', prompt: '' }], 'batch');
		batches.update('p1', batch.batchId, (value) =>
			replaceBatchAgent(value, 'a', { status: 'starting' })
		);

		batches.reconcileInterrupted('p1');

		expect(batches.current('p1')?.agents[0].status).toBe('start-interrupted');
	});

	test('restore reconciles interrupted agents once but create does not interrupt a fresh batch', () => {
		const storage = new MapStorage();
		const seed = createYamlRunBatch('p1', [{ name: 'a', prompt: 'prompt' }], '2026-01-01T00:00:00Z', 'restored');
		storage.setItem('agent-compose:yaml-run:p1', JSON.stringify(seed));
		const batches = createYamlRunBatchStore(storage);
		expect(batches.restore('p1')?.agents[0].status).toBe('start-interrupted');
		expect(batches.restore('p1')?.agents[0].status).toBe('start-interrupted');
		const fresh = batches.create('p1', [{ name: 'b', prompt: 'fresh' }], 'fresh');
		expect(fresh.agents[0].status).toBe('waiting');
		expect(batches.current('p1')?.agents[0].status).toBe('waiting');
	});

	test('an older tab cannot overwrite a newer stored batch and storage events use deterministic ordering', () => {
		const storage = new MapStorage();
		const oldTab = createYamlRunBatchStore(storage);
		const old = oldTab.create('p1', [{ name: 'old', prompt: '' }], 'old');
		storage.setItem('agent-compose:yaml-run:p1', JSON.stringify(createYamlRunBatch('p1', [{ name: 'new', prompt: '' }], '2099-01-01T00:00:00Z', 'new')));
		expect(oldTab.update('p1', old.batchId, value => replaceBatchAgent(value, 'old', { status: 'running' }))).toBe(false);
		expect(oldTab.current('p1')?.batchId).toBe('new');

		const older = createYamlRunBatch('p1', [], '2000-01-01T00:00:00Z', 'z');
		expect(oldTab.applyStorageEvent('agent-compose:yaml-run:p1', JSON.stringify(older))).toBe(false);
		expect(oldTab.current('p1')?.batchId).toBe('new');
	});

	test('lazily restores normalized projects and tracks mutations by generation', () => {
		const storage = new MapStorage();
		const writer = createYamlRunBatchStore(storage);
		writer.create('sha256:p1', [{ name: 'a', prompt: 'A' }], 'batch');

		const batches = createYamlRunBatchStore(storage);
		expect(batches.generation('p1')).toBe(0);
		expect(batches.current(' p1 ')?.batchId).toBe('batch');
		expect(batches.generation('sha256:p1')).toBe(0);

		const batch = batches.create('p1', [{ name: 'b', prompt: 'B' }], 'replacement');
		expect(batches.generation('sha256:p1')).toBe(1);
		expect(batches.update('sha256:p1', batch.batchId, (value) => value)).toBe(true);
		expect(batches.generation('p1')).toBe(2);

		batches.clearProject(' sha256:p1 ');
		expect(batches.current('p1')).toBeUndefined();
		expect(batches.generation('p1')).toBe(3);
		expect(storage.getItem('agent-compose:yaml-run:p1')).toBeNull();
	});

	test('publishes the validated event value instead of rereading current storage', () => {
		const storage = new MapStorage();
		const batches = createYamlRunBatchStore(storage);
		batches.create('p1', [{ name: 'a', prompt: '' }], 'current');
		const incoming = createYamlRunBatch('p1', [{ name: 'b', prompt: '' }], 'now', 'incoming');

		batches.applyStorageEvent('agent-compose:yaml-run:p1', JSON.stringify(incoming));

		expect(batches.current('p1')?.batchId).toBe('incoming');
		expect(JSON.parse(storage.getItem('agent-compose:yaml-run:p1') ?? '{}').batchId).toBe(
			'current'
		);
	});

	test('rejects mismatched snapshots and non-canonical event keys', () => {
		const storage = new MapStorage();
		const batches = createYamlRunBatchStore(storage);
		batches.create('p1', [{ name: 'a', prompt: '' }], 'current');
		const wrongProject = createYamlRunBatch('p2', [], 'now', 'wrong');

		for (const [key, value] of [
			['agent-compose:yaml-run:p1', JSON.stringify(wrongProject)],
			['agent-compose:yaml-run:', null],
			['agent-compose:yaml-run:sha256:p1', null],
			['agent-compose:yaml-run: p1', null]
		]) {
			batches.applyStorageEvent(key, value);
		}

		expect(batches.current('p1')?.batchId).toBe('current');
	});

	test('requires the payload project id to exactly match the canonical event key', () => {
		const storage = new MapStorage();
		const batches = createYamlRunBatchStore(storage);
		batches.create('p1', [{ name: 'a', prompt: '' }], 'current');
		const generation = batches.generation('p1');
		const canonical = createYamlRunBatch('p1', [], 'now', 'incoming');

		for (const projectId of ['sha256:p1', ' p1 ']) {
			batches.applyStorageEvent(
				'agent-compose:yaml-run:p1',
				JSON.stringify({ ...canonical, projectId })
			);
		}

		expect(batches.current('p1')?.batchId).toBe('current');
		expect(batches.generation('p1')).toBe(generation);
		expect(
			batches.applyStorageEvent('agent-compose:yaml-run:p1', JSON.stringify(canonical))
		).toBe(true);
		expect(batches.current('p1')?.batchId).toBe('incoming');
		expect(batches.generation('p1')).toBe(generation + 1);
	});

	test('a canonical storage removal event clears the project', () => {
		const storage = new MapStorage();
		const batches = createYamlRunBatchStore(storage);
		batches.create('p1', [{ name: 'a', prompt: '' }], 'current');

		batches.applyStorageEvent('agent-compose:yaml-run:p1', null);

		expect(batches.current('p1')).toBeUndefined();
	});

	test('falls back when obtaining browser storage throws', () => {
		const storage = resolveBrowserStorage(() => {
			throw new DOMException('denied', 'SecurityError');
		});

		expect(storage.getItem('key')).toBeNull();
		expect(() => storage.setItem('key', 'value')).not.toThrow();
	});
});
