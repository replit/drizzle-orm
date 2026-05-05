import { describe, expect, test, vi } from 'vitest';
import { fromDatabase } from '../src/serializer/pgSerializer';

const TABLES_QUERY_MARKER = 'pg_catalog.pg_class c';

function createObservedDb({ tableCount }: { tableCount: number }) {
	let activeQueries = 0;
	let maxActiveQueries = 0;

	const query = vi.fn(async (sql: string) => {
		activeQueries += 1;
		maxActiveQueries = Math.max(maxActiveQueries, activeQueries);

		await new Promise((resolve) => setTimeout(resolve, 5));

		activeQueries -= 1;

		if (sql.includes(TABLES_QUERY_MARKER)) {
			return Array.from({ length: tableCount }, (_, index) => ({
				table_schema: 'public',
				table_name: `table_${index}`,
				type: 'table',
				rls_enabled: false,
			}));
		}

		return [];
	});

	return {
		db: { query },
		query,
		getMaxActiveQueries: () => maxActiveQueries,
	};
}

describe('fromDatabase', () => {
	test('limits table introspection fanout with tableConcurrency', async () => {
		const observed = createObservedDb({ tableCount: 8 });

		await fromDatabase(
			observed.db as any,
			undefined,
			[],
			undefined,
			undefined,
			undefined,
			{ tableConcurrency: 2 },
		);

		expect(observed.query).toHaveBeenCalled();
		expect(observed.getMaxActiveQueries()).toBeLessThanOrEqual(2);
	});

	test('rejects invalid tableConcurrency values', async () => {
		const observed = createObservedDb({ tableCount: 1 });

		await expect(
			fromDatabase(
				observed.db as any,
				undefined,
				[],
				undefined,
				undefined,
				undefined,
				{ tableConcurrency: 0 },
			),
		).rejects.toThrow('tableConcurrency must be a positive integer');
		await expect(
			fromDatabase(
				observed.db as any,
				undefined,
				[],
				undefined,
				undefined,
				undefined,
				{ tableConcurrency: -1 },
			),
		).rejects.toThrow('tableConcurrency must be a positive integer');
		await expect(
			fromDatabase(
				observed.db as any,
				undefined,
				[],
				undefined,
				undefined,
				undefined,
				{ tableConcurrency: 1.5 },
			),
		).rejects.toThrow('tableConcurrency must be a positive integer');
	});
});
