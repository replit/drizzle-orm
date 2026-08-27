import { describe, expect, test, vi } from 'vitest';
import type { JsonStatement } from '../src/dialects/postgres/statements';
import { pgSchema, pgSuggestions, preparePgDB, squashPgScheme } from '../src/ext/api';

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

vi.mock('../src/cli/commands/push-postgres', () => ({
	suggestions: vi.fn(async () => []),
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
			db.proxy({ method: 'all', mode: 'array', params: [], sql: 'select 4' }),
			db.proxy({ method: 'all', mode: 'object', params: [], sql: 'select 5' }),
		]);

		expect(observed.query).toHaveBeenCalledTimes(5);
		expect(observed.getMaxActiveQueries()).toBe(2);
	});

	test('rejects invalid queryConcurrency values', async () => {
		const observed = createObservedPool();

		await expect(
			preparePgDB(observed.pool as any, { queryConcurrency: 0 }),
		).rejects.toThrow('queryConcurrency must be a positive integer');
		await expect(
			preparePgDB(observed.pool as any, { queryConcurrency: -1 }),
		).rejects.toThrow('queryConcurrency must be a positive integer');
		await expect(
			preparePgDB(observed.pool as any, { queryConcurrency: 1.5 }),
		).rejects.toThrow('queryConcurrency must be a positive integer');
	});
});

describe('Replit compatibility API', () => {
	test('keeps the legacy empty target schema accepted by pid2', () => {
		const schema = pgSchema.parse({
			version: '7',
			dialect: 'postgresql',
			id: '00000000-0000-0000-0000-000000000000',
			prevId: '',
			tables: {},
			enums: {},
			schemas: {},
			policies: {},
			roles: {},
			sequences: {},
			views: {},
			_meta: {},
		});

		const ddl = squashPgScheme(schema, 'push');

		expect(ddl.entities.list()).toHaveLength(0);
	});

	test('returns executable SQL from v1 json statements', async () => {
		const db = { query: vi.fn() };
		const statements: JsonStatement[] = [{ type: 'create_schema', name: 'private' }];

		const result = await pgSuggestions(db, statements);

		expect(result.statementsToExecute).toEqual(['CREATE SCHEMA "private";\n']);
		expect(result.shouldAskForApprove).toBe(false);
	});
});
