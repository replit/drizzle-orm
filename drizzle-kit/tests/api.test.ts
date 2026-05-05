import { describe, expect, test, vi } from 'vitest';
import { preparePgDB } from '../src/api';

vi.mock('pg', () => ({
	default: {
		types: {
			builtins: {
				DATE: 1082,
				INTERVAL: 1186,
				TIMESTAMP: 1114,
				TIMESTAMPTZ: 1184,
			},
			getTypeParser: vi.fn(() => (value: unknown) => value),
		},
	},
}));

vi.mock('drizzle-orm/node-postgres', () => ({
	drizzle: vi.fn().mockReturnValue({}),
}));

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
	migrate: vi.fn(),
}));

function createObservedPool() {
	let activeQueries = 0;
	let maxActiveQueries = 0;

	const query = vi.fn(async (input: { text: string }) => {
		activeQueries += 1;
		maxActiveQueries = Math.max(maxActiveQueries, activeQueries);

		await new Promise((resolve) => setTimeout(resolve, 10));

		activeQueries -= 1;
		return { rows: [input.text] };
	});

	return {
		pool: { query },
		query,
		getMaxActiveQueries: () => maxActiveQueries,
	};
}

describe('preparePgDB', () => {
	test('does not limit query concurrency by default', async () => {
		const observed = createObservedPool();
		const db = await preparePgDB(observed.pool as any);

		await Promise.all([
			db.query('select 1'),
			db.query('select 2'),
			db.query('select 3'),
			db.query('select 4'),
		]);

		expect(observed.query).toHaveBeenCalledTimes(4);
		expect(observed.getMaxActiveQueries()).toBe(4);
	});

	test('limits query and proxy calls with queryConcurrency', async () => {
		const observed = createObservedPool();
		const db = await preparePgDB(observed.pool as any, {
			queryConcurrency: 2,
		});

		await Promise.all([
			db.query('select 1'),
			db.query('select 2'),
			db.query('select 3'),
			db.proxy({ mode: 'array', params: [], sql: 'select 4' }),
			db.proxy({ mode: 'object', params: [], sql: 'select 5' }),
		]);

		expect(observed.query).toHaveBeenCalledTimes(5);
		expect(observed.getMaxActiveQueries()).toBe(2);
	});
});
