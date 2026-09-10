import { expect, test, vi } from 'vitest';
import { introspectPgDB } from '../src/api';
import type { DrizzlePgDB } from '../src/api';

const columnRow = {
	is_nullable: 'NO',
	array_dimensions: 0,
	data_type: 'integer',
	seq_name: null,
	column_default: null,
	additional_dt: 'integer',
	enum_name: 'int4',
	is_generated: 'NEVER',
	generation_expression: null,
	is_identity: 'NO',
	identity_generation: null,
	identity_start: null,
	identity_increment: null,
	identity_maximum: null,
	identity_minimum: null,
	identity_cycle: 'NO',
	type_schema: 'pg_catalog',
};

const tables = ['first', 'second'];

function constraintsFor(table: string) {
	return ['a', 'b'].map((columnName) => ({
		table_name: table,
		column_name: columnName,
		constraint_type: 'PRIMARY KEY',
		constraint_name: `${table}_pkey`,
	}));
}

function database(failPreloads = false) {
	const queries: string[] = [];
	const query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
		queries.push(sql);
		const constraintPreload = sql.includes("pg_has_role(rel.relowner, 'USAGE')");
		const primaryKeyPreload = sql.includes('rel.relname AS table_name, con.conname AS primary_key');
		if (failPreloads && (constraintPreload || primaryKeyPreload)) {
			throw new Error('preload failed');
		}
		if (sql.includes("c.relkind IN ('r', 'v', 'm')")) {
			return tables.map((table_name) => ({
				table_schema: 'public',
				table_name,
				type: 'table',
				rls_enabled: false,
			})) as T[];
		}
		if (sql.includes('a.attndims AS array_dimensions')) {
			const table = sql.match(/cls\.relname = '([^']+)'/)?.[1];
			return ['a', 'b'].map((column_name) => ({ ...columnRow, table_name: table, column_name })) as T[];
		}
		if (constraintPreload) {
			return tables.flatMap(constraintsFor) as T[];
		}
		if (primaryKeyPreload) {
			return tables.map((table_name) => ({ table_name, primary_key: `${table_name}_pkey` })) as T[];
		}
		if (sql.includes('information_schema.constraint_column_usage')) {
			const table = sql.match(/tc\.table_name = '([^']+)'/)?.[1];
			return constraintsFor(table ?? '') as T[];
		}
		if (sql.includes('SELECT conname AS primary_key')) {
			return [{ primary_key: `${params?.[1]}_pkey` }] as T[];
		}

		return [];
	};

	return { db: { query } as DrizzlePgDB, queries };
}

test('preloads constraints once per schema only when enabled', async () => {
	const baselineDatabase = database();
	const baseline = await introspectPgDB(baselineDatabase.db, [], ['public']);
	const batchedDatabase = database();
	const batched = await introspectPgDB(batchedDatabase.db, [], ['public'], {
		batchConstraintQueries: true,
	});

	expect(batched).toEqual(baseline);
	expect(batchedDatabase.queries.filter((sql) => sql.includes("pg_has_role(rel.relowner, 'USAGE')"))).toHaveLength(1);
	expect(
		batchedDatabase.queries.filter((sql) => sql.includes('rel.relname AS table_name, con.conname AS primary_key')),
	).toHaveLength(1);
	expect(batchedDatabase.queries.filter((sql) => sql.includes('information_schema.constraint_column_usage')))
		.toHaveLength(0);
});

test('falls back to per-table queries when preloading fails', async () => {
	const baseline = await introspectPgDB(database().db, [], ['public']);
	const fallbackDatabase = database(true);
	const onConstraintPreloadError = vi.fn();
	const fallback = await introspectPgDB(fallbackDatabase.db, [], ['public'], {
		batchConstraintQueries: true,
		onConstraintPreloadError,
	});

	expect(fallback).toEqual(baseline);
	expect(onConstraintPreloadError).toHaveBeenCalledTimes(2);
	expect(fallbackDatabase.queries.filter((sql) => sql.includes('information_schema.constraint_column_usage')))
		.toHaveLength(2);
});
