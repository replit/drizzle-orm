import { expect, test } from 'vitest';
import { introspectPgDB } from '../src/api';
import type { DrizzlePgDB } from '../src/api';
import { schemaToTypeScript } from '../src/introspect-pg';
import { fromDatabase } from '../src/serializer/pgSerializer';

const columnRow = {
	table_name: 'items',
	is_nullable: 'YES',
	array_dimensions: 0,
	data_type: 'jsonb',
	seq_name: null,
	additional_dt: 'jsonb',
	enum_name: 'jsonb',
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

function databaseWithDefault(columnDefault: string): DrizzlePgDB {
	const query = async (sql: string): Promise<Record<string, unknown>[]> => {
		if (sql.includes("c.relkind IN ('r', 'v', 'm')")) {
			return [{ table_schema: 'public', table_name: 'items', type: 'table', rls_enabled: false }];
		}
		if (sql.includes('a.attndims AS array_dimensions')) {
			return [{ ...columnRow, column_name: 'payload', column_default: columnDefault }];
		}

		return [];
	};

	return { query } as DrizzlePgDB;
}

test('introspects a jsonb expression default without parsing it as JSON', async () => {
	const expression = "jsonb_build_object('kind'::text, 'record'::text)";
	const schema = await introspectPgDB(databaseWithDefault(expression), [], ['public']);

	expect(schema.tables['public.items']!.columns.payload!.default).toBe(expression);
});

test('normalizes a quoted jsonb literal default', async () => {
	const schema = await introspectPgDB(databaseWithDefault(`'{"kind": "record"}'::jsonb`), [], ['public']);

	expect(schema.tables['public.items']!.columns.payload!.default).toBe(`'{"kind":"record"}'::jsonb`);
});

test('preserves casts and generates SQL for jsonb expression defaults', async () => {
	const expression = "current_setting('app.payload')::jsonb";
	const schema = await fromDatabase(databaseWithDefault(expression), () => true, ['public']);

	expect(schema.tables['public.items']!.columns.payload!.default).toBe(expression);
	expect(schemaToTypeScript(schema, 'preserve').file).toContain(`.default(sql\`${expression}\`)`);
});
