import { describe, expect, test } from 'bun:test';
import {
	batchStats,
	createYamlRunBatch,
	readYamlRunBatch,
	replaceBatchAgent,
	writeYamlRunBatch
} from './yaml-run-batch';

class MapStorage {
	values = new Map();

	getItem(key) {
		return this.values.get(key) ?? null;
	}

	setItem(key, value) {
		this.values.set(key, value);
	}
}

describe('yaml run batch', () => {
	test('creates a batch ID when crypto.randomUUID is unavailable', () => {
		const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
		Object.defineProperty(globalThis, 'crypto', {
			configurable: true,
			value: { getRandomValues: crypto.getRandomValues.bind(crypto) }
		});
		try {
			const batch = createYamlRunBatch('p1', [{ name: 'a', prompt: '' }], 'now');
			expect(batch.batchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		} finally {
			if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
			else delete globalThis.crypto;
		}
	});

	test('creates agents in YML order and derives running/completed state', () => {
		const batch = createYamlRunBatch(
			'p1',
			[
				{ name: 'a', prompt: 'A' },
				{ name: 'b', prompt: 'B' }
			],
			'2026-07-15T10:00:00Z',
			'batch-1'
		);
		expect(batch.agents.map((agent) => agent.agentName)).toEqual(['a', 'b']);
		expect(batchStats(batch)).toMatchObject({ total: 2, completed: 0, active: true });
		const done = replaceBatchAgent(
			replaceBatchAgent(batch, 'a', { status: 'succeeded' }),
			'b',
			{ status: 'start-failed', startError: 'offline' }
		);
		expect(batchStats(done)).toMatchObject({ total: 2, completed: 2, active: false });
	});

	test('round trips only valid project-scoped version 1 snapshots', () => {
		const storage = new MapStorage();
		const batch = createYamlRunBatch('p1', [{ name: 'a', prompt: '' }], 'now', 'batch-1');
		writeYamlRunBatch(storage, batch);
		expect(readYamlRunBatch(storage, 'p1')).toEqual(batch);
		expect(readYamlRunBatch(storage, 'p2')).toBeUndefined();
		storage.setItem('agent-compose:yaml-run:p1', '{"version":2}');
		expect(readYamlRunBatch(storage, 'p1')).toBeUndefined();
	});

	test('rejects malformed snapshots and normalizes project IDs', () => {
		const storage = new MapStorage();
		const batch = createYamlRunBatch('sha256:p1', [{ name: 'a', prompt: 'A' }], 'now', 'batch-1');
		writeYamlRunBatch(storage, batch);
		expect(readYamlRunBatch(storage, ' p1 ')).toEqual(batch);

		for (const invalid of [
			{ ...batch, projectId: 'p2' },
			{ ...batch, completedAt: 1 },
			{ ...batch, agents: [{ ...batch.agents[0], status: 'unknown' }] },
			{ ...batch, agents: [{ ...batch.agents[0], agentName: '' }] },
			{ ...batch, agents: [batch.agents[0], batch.agents[0]] }
		]) {
			storage.setItem('agent-compose:yaml-run:p1', JSON.stringify(invalid));
			expect(readYamlRunBatch(storage, 'p1')).toBeUndefined();
		}
	});

	test('catches storage and JSON exceptions', () => {
		expect(readYamlRunBatch({ getItem: () => '{' }, 'p1')).toBeUndefined();
		expect(readYamlRunBatch({ getItem: () => { throw new Error('offline'); } }, 'p1')).toBeUndefined();
		expect(() =>
			writeYamlRunBatch({ setItem: () => { throw new Error('offline'); } }, createYamlRunBatch('p1', []))
		).not.toThrow();
	});
});
