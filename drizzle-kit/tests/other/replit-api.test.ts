import type { Pool } from 'pg';
import { describe, expect, test, vi } from 'vitest';
import {
	applyPgSnapshotsDiff,
	columnsResolver,
	createEmptyPgSchema,
	enumsResolver,
	indPolicyResolver,
	pgSuggestions,
	policyResolver,
	preparePgDB,
	roleResolver,
	schemasResolver,
	sequencesResolver,
	squashPgScheme,
	tablesResolver,
	viewsResolver,
} from '../../src/ext/api';
import type { DB } from '../../src/utils';

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

		if (input.text === 'fail') throw new Error('query failed');
		return { rows: [input.text] };
	});

	return {
		pool: { query } as unknown as Pool,
		query,
		getMaxActiveQueries: () => maxActiveQueries,
	};
}

function usersSchema(unique = false) {
	const ddl = squashPgScheme(createEmptyPgSchema());
	ddl.tables.push({
		schema: 'public',
		name: 'users',
		isRlsEnabled: false,
	});
	ddl.columns.push({
		schema: 'public',
		table: 'users',
		name: 'email',
		type: 'text',
		typeSchema: null,
		notNull: true,
		dimensions: 0,
		default: null,
		generated: null,
		identity: null,
	});
	if (unique) {
		ddl.uniques.push({
			schema: 'public',
			table: 'users',
			name: 'users_email_unique',
			nameExplicit: true,
			columns: ['email'],
			nullsNotDistinct: false,
		});
	}

	return ddl;
}

async function diffSchemas(
	target: ReturnType<typeof usersSchema>,
	source: ReturnType<typeof usersSchema>,
) {
	const emptySchema = createEmptyPgSchema();
	return applyPgSnapshotsDiff(
		target,
		source,
		schemasResolver,
		enumsResolver,
		sequencesResolver,
		policyResolver,
		indPolicyResolver,
		roleResolver,
		tablesResolver,
		columnsResolver,
		viewsResolver,
		emptySchema,
		emptySchema,
		'push',
	);
}

describe('preparePgDB', () => {
	test('limits query and proxy concurrency and resumes after rejection', async () => {
		const observed = createObservedPool();
		const db = await preparePgDB(observed.pool, { queryConcurrency: 2 });

		const results = await Promise.allSettled([
			db.query('select 1'),
			db.query('fail'),
			db.query('select 2'),
			db.proxy({ method: 'all', mode: 'array', params: [], sql: 'select 3' }),
		]);

		expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
		expect(observed.query).toHaveBeenCalledTimes(4);
		expect(observed.getMaxActiveQueries()).toBe(2);
	});

	test('rejects invalid query concurrency', async () => {
		const observed = createObservedPool();
		await expect(preparePgDB(observed.pool, { queryConcurrency: 0 })).rejects.toThrow(
			'queryConcurrency must be a positive integer',
		);
	});
});

describe('Replit compatibility API', () => {
	test('generates executable SQL through the legacy resolver contract', async () => {
		const result = await diffSchemas(squashPgScheme(createEmptyPgSchema()), usersSchema());

		expect(result.sqlStatements.join('\n')).toContain('CREATE TABLE "users"');
		expect(result.sqlStatements.join('\n')).toContain('"email" text NOT NULL');
	});

	test('reports destructive changes only when the target contains data', async () => {
		const result = await diffSchemas(usersSchema(), squashPgScheme(createEmptyPgSchema()));
		const db: DB = {
			query: vi.fn().mockResolvedValue([{ count: '3' }]),
		};

		const suggestions = await pgSuggestions(db, result.statements);

		expect(suggestions.shouldAskForApprove).toBe(true);
		expect(suggestions.tablesToRemove).toEqual(['users']);
		expect(suggestions.statementsToExecute.join('\n')).toContain('DROP TABLE "users"');
	});

	test('places an approved truncate before a new unique constraint', async () => {
		const result = await diffSchemas(usersSchema(), usersSchema(true));
		const db: DB = {
			query: vi.fn().mockResolvedValue([{ count: '2' }]),
		};
		const selectResolver = vi.fn().mockResolvedValue({ data: { index: 1, value: 'yes' } });

		const suggestions = await pgSuggestions(db, result.statements, selectResolver);

		expect(suggestions.tablesToTruncate).toEqual(['users']);
		expect(suggestions.statementsToExecute[0]).toBe('truncate table "users" cascade;');
		expect(suggestions.statementsToExecute.join('\n')).toContain('UNIQUE');
	});
});
