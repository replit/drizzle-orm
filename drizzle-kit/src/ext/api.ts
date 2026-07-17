import type { MigrationConfig } from 'drizzle-orm/migrator';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import type { Resolver } from '../dialects/common';
import { fromJson } from '../dialects/postgres/convertor';
import type {
	CheckConstraint,
	Column,
	Enum,
	ForeignKey,
	Index,
	InterimSchema,
	Policy,
	PostgresDDL,
	PostgresEntities,
	PrimaryKey,
	Privilege,
	Role,
	Schema,
	Sequence,
	UniqueConstraint,
	View,
} from '../dialects/postgres/ddl';
import { interimToDDL } from '../dialects/postgres/ddl';
import { ddlDiff } from '../dialects/postgres/diff';
import { fromDatabaseForDrizzle } from '../dialects/postgres/introspect';
import type { JsonStatement } from '../dialects/postgres/statements';
import { prepareEntityFilter } from '../dialects/pull-utils';
import '../@types/utils';

type Queryable = Pool | PoolClient;
type Named = { name: string; schema?: string; table?: string };
type TableNamed = Named & { schema: string; table: string };
type RenamePromptItem<T extends Named> = { from: T; to: T };
type QueryDB = {
	query: <T extends any = any>(sql: string, params?: any[]) => Promise<T[]>;
};
type ProxyParams = {
	sql: string;
	params?: any[];
	mode: 'array' | 'object';
	method: 'values' | 'get' | 'all' | 'run' | 'execute';
};

export type DrizzlePgDB = QueryDB & {
	proxy: (params: ProxyParams) => Promise<any[]>;
	migrate: (config: string | MigrationConfig) => Promise<void>;
};

export type PreparePgDBOptions = {
	queryConcurrency?: number;
};

export type DrizzlePgDBIntrospectSchema = InterimSchema;

export type LegacyResolverInput<T extends Named> = {
	created: T[];
	deleted: T[];
	schema?: string;
	tableName?: string;
};

export type LegacyResolverOutput<T extends Named> = {
	created: T[];
	deleted: T[];
	renamed?: RenamePromptItem<T>[];
	renamedOrMoved?: RenamePromptItem<T>[];
	moved?: { name: string; schemaFrom: string; schemaTo: string }[];
};

export type LegacyResolver<T extends Named> = (
	input: LegacyResolverInput<T>,
) => Promise<LegacyResolverOutput<T>>;

export type TableScopedResolverInput<T extends TableNamed> =
	& Omit<
		LegacyResolverInput<T>,
		'schema' | 'tableName'
	>
	& {
		schema: string;
		tableName: string;
	};

export type TableScopedResolver<T extends TableNamed> = (
	input: TableScopedResolverInput<T>,
) => Promise<LegacyResolverOutput<T>>;

const defaultMigrationsConfig = {
	schema: 'drizzle',
	table: '__drizzle_migrations',
};

const passthroughResolver = async <T extends Named>({ created, deleted }: LegacyResolverInput<T>) => {
	return { created, deleted, renamed: [] };
};

export const schemasResolver: LegacyResolver<Schema> = passthroughResolver;
export const enumsResolver: LegacyResolver<Enum> = passthroughResolver;
export const sequencesResolver: LegacyResolver<Sequence> = passthroughResolver;
export const policyResolver: TableScopedResolver<Policy> = passthroughResolver;
export const indPolicyResolver: LegacyResolver<Policy> = passthroughResolver;
export const roleResolver: LegacyResolver<Role> = passthroughResolver;
export const tablesResolver: LegacyResolver<PostgresEntities['tables']> = passthroughResolver;
export const columnsResolver: TableScopedResolver<Column> = passthroughResolver;
export const viewsResolver: LegacyResolver<View> = passthroughResolver;

export type ResolverInput<T extends Named = Named> = LegacyResolverInput<T>;
export type ColumnsResolverInput = TableScopedResolverInput<Column>;
export type PolicyResolverInput = TableScopedResolverInput<Policy>;
export type TablePolicyResolverInput = TableScopedResolverInput<Policy>;
export type RolesResolverInput = LegacyResolverInput<Role>;
export type { Enum, Role, Sequence, View };
export type Table = PostgresEntities['tables'];

export type SelectResolverInput = {
	entity: {
		type: 'createUniqueConstraint';
		name: string;
		count: number;
		tableName: string;
	};
	items: string[];
};

export type SelectResolverOutput = {
	data: {
		index: number;
		value: string;
	};
};

type SelectResolver = (input: SelectResolverInput) => Promise<SelectResolverOutput>;

function createConcurrencyLimiter(concurrency?: number) {
	if (concurrency === undefined) {
		return <T>(run: () => Promise<T>) => run();
	}

	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new RangeError('queryConcurrency must be a positive integer');
	}

	let activeCount = 0;
	const queue: Array<() => void> = [];

	const runNext = () => {
		if (activeCount >= concurrency) return;

		const next = queue.shift();
		if (!next) return;

		activeCount += 1;
		next();
	};

	return <T>(run: () => Promise<T>) => {
		return new Promise<T>((resolve, reject) => {
			queue.push(() => {
				Promise.resolve()
					.then(run)
					.then(resolve, reject)
					.finally(() => {
						activeCount -= 1;
						runNext();
					});
			});

			runNext();
		});
	};
}

export const preparePgDB = async (
	pool: Queryable,
	options: PreparePgDBOptions = {},
): Promise<DrizzlePgDB> => {
	const { default: pg } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const { migrate } = await import('drizzle-orm/node-postgres/migrator');

	const getTypeParser: typeof pg.types.getTypeParser = (typeId, format) => {
		if (
			typeId === pg.types.builtins.TIMESTAMPTZ
			|| typeId === pg.types.builtins.TIMESTAMP
			|| typeId === pg.types.builtins.DATE
			|| typeId === pg.types.builtins.INTERVAL
		) {
			return (value: string) => value;
		}

		return pg.types.getTypeParser(typeId, format);
	};

	const limitQuery = createConcurrencyLimiter(options.queryConcurrency);
	const types = { getTypeParser };

	const query: QueryDB['query'] = async (sql, params) => {
		const config: QueryConfig = {
			text: sql,
			values: params ?? [],
			types,
		};
		const result = await limitQuery(() => pool.query(config));
		return result.rows;
	};

	const proxy: DrizzlePgDB['proxy'] = async (params) => {
		const config: QueryConfig = {
			text: params.sql,
			values: params.params,
			...(params.mode === 'array' && { rowMode: 'array' }),
			types,
		};
		const result = await limitQuery(() => pool.query(config));
		return result.rows;
	};

	const migrateFn = async (config: string | MigrationConfig) => {
		const db = drizzle({ client: pool });
		await migrate(db, config as MigrationConfig);
	};

	return { query, proxy, migrate: migrateFn };
};

export const createEmptyPgSchema = (): DrizzlePgDBIntrospectSchema => ({
	schemas: [],
	enums: [],
	tables: [],
	columns: [],
	indexes: [],
	pks: [],
	fks: [],
	uniques: [],
	checks: [],
	sequences: [],
	roles: [],
	privileges: [],
	policies: [],
	views: [],
	viewColumns: [],
});

export const introspectPgDB = async (
	db: DrizzlePgDB,
	filters: string[],
	schemaFilters: string[],
): Promise<DrizzlePgDBIntrospectSchema> => {
	const filter = prepareEntityFilter('postgresql', {
		tables: filters,
		schemas: schemaFilters,
		entities: undefined,
		extensions: [],
	}, []);

	return fromDatabaseForDrizzle(db, filter, () => {}, defaultMigrationsConfig);
};

function isDDL(schema: DrizzlePgDBIntrospectSchema | PostgresDDL): schema is PostgresDDL {
	return 'entities' in schema;
}

export const pgSchema = {
	parse: (schema: DrizzlePgDBIntrospectSchema) => schema,
};

export const squashPgScheme = (
	schema: DrizzlePgDBIntrospectSchema | PostgresDDL,
	_mode?: 'default' | 'push',
): PostgresDDL => {
	if (isDDL(schema)) return schema;

	const { ddl, errors } = interimToDDL(schema);
	if (errors.length > 0) {
		throw new Error(`Failed to convert Postgres schema: ${JSON.stringify(errors)}`);
	}

	return ddl;
};

function movedToRenamed<T extends Named>(
	moved: { name: string; schemaFrom: string; schemaTo: string },
	created: T[],
	deleted: T[],
): RenamePromptItem<T> {
	const from = deleted.find((item) => item.name === moved.name && (item.schema ?? 'public') === moved.schemaFrom);
	const to = created.find((item) => item.name === moved.name && (item.schema ?? 'public') === moved.schemaTo);
	if (!from || !to) {
		throw new Error(`Invalid move for ${moved.name}: ${moved.schemaFrom} -> ${moved.schemaTo}`);
	}

	return { from, to };
}

function adaptResolver<T extends Named>(resolver: LegacyResolver<T>): Resolver<T> {
	return async ({ created, deleted }) => {
		const sample = created[0] ?? deleted[0];
		const result = await resolver({
			created,
			deleted,
			schema: sample?.schema,
			tableName: sample?.table,
		});

		return {
			created: result.created,
			deleted: result.deleted,
			renamedOrMoved: [
				...(result.renamed ?? []),
				...(result.renamedOrMoved ?? []),
				...(result.moved ?? []).map((move) => movedToRenamed(move, created, deleted)),
			],
		};
	};
}

function adaptTableScopedResolver<T extends TableNamed>(resolver: TableScopedResolver<T>): Resolver<T> {
	return async ({ created, deleted }) => {
		const sample = created[0] ?? deleted[0];
		if (!sample) return { created, deleted, renamedOrMoved: [] };

		const result = await resolver({
			created,
			deleted,
			schema: sample.schema,
			tableName: sample.table,
		});

		return {
			created: result.created,
			deleted: result.deleted,
			renamedOrMoved: [
				...(result.renamed ?? []),
				...(result.renamedOrMoved ?? []),
				...(result.moved ?? []).map((move) => movedToRenamed(move, created, deleted)),
			],
		};
	};
}

const noOpV1Resolver = async <T extends Named>({ created, deleted }: LegacyResolverInput<T>) => {
	return { created, deleted, renamedOrMoved: [] };
};

export const applyPgSnapshotsDiff = async (
	targetSchema: PostgresDDL,
	sourceSchema: PostgresDDL,
	schemasResolverArg: LegacyResolver<Schema>,
	enumsResolverArg: LegacyResolver<Enum>,
	sequencesResolverArg: LegacyResolver<Sequence>,
	policyResolverArg: TableScopedResolver<Policy>,
	_indPolicyResolverArg: LegacyResolver<Policy>,
	roleResolverArg: LegacyResolver<Role>,
	tablesResolverArg: LegacyResolver<PostgresEntities['tables']>,
	columnsResolverArg: TableScopedResolver<Column>,
	viewsResolverArg: LegacyResolver<View>,
	_validatedTarget: DrizzlePgDBIntrospectSchema,
	_validatedSource: DrizzlePgDBIntrospectSchema,
	mode: 'default' | 'push',
) => {
	return ddlDiff(
		targetSchema,
		sourceSchema,
		adaptResolver(schemasResolverArg),
		adaptResolver(enumsResolverArg),
		adaptResolver(sequencesResolverArg),
		adaptTableScopedResolver(policyResolverArg),
		adaptResolver(roleResolverArg),
		noOpV1Resolver<Privilege>,
		adaptResolver(tablesResolverArg),
		adaptTableScopedResolver(columnsResolverArg),
		adaptResolver(viewsResolverArg),
		noOpV1Resolver<UniqueConstraint>,
		noOpV1Resolver<Index>,
		noOpV1Resolver<CheckConstraint>,
		noOpV1Resolver<PrimaryKey>,
		noOpV1Resolver<ForeignKey>,
		mode,
	);
};

function quoteIdentifier(value: string) {
	return `"${value.replaceAll('"', '""')}"`;
}

function quotedTable(schema: string | undefined, table: string) {
	return schema && schema !== 'public'
		? `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
		: quoteIdentifier(table);
}

async function countRows(db: QueryDB, schema: string | undefined, table: string) {
	const rows = await db.query<{ count: string | number }>(
		`select count(*) as count from ${quotedTable(schema, table)}`,
	);
	return Number(rows[0]?.count ?? 0);
}

export const pgSuggestions = async (
	db: QueryDB,
	statements: JsonStatement[],
	selectResolver?: SelectResolver,
) => {
	let shouldAskForApprove = false;
	const statementsToExecute: string[] = [];
	const infoToPrint: string[] = [];
	const matViewsToRemove: string[] = [];
	const columnsToRemove: string[] = [];
	const schemasToRemove: string[] = [];
	const tablesToTruncate: string[] = [];
	const tablesToRemove: string[] = [];

	for (const statement of statements) {
		if (statement.type === 'drop_table') {
			const count = await countRows(db, statement.table.schema, statement.table.name);
			if (count > 0) {
				infoToPrint.push(`You're about to delete ${statement.table.name} table with ${count} items`);
				tablesToRemove.push(statement.table.name);
				shouldAskForApprove = true;
			}
		} else if (statement.type === 'drop_view' && statement.view.materialized) {
			const count = await countRows(db, statement.view.schema, statement.view.name);
			if (count > 0) {
				infoToPrint.push(`You're about to delete ${statement.view.name} materialized view with ${count} items`);
				matViewsToRemove.push(statement.view.name);
				shouldAskForApprove = true;
			}
		} else if (statement.type === 'drop_column') {
			const count = await countRows(db, statement.column.schema, statement.column.table);
			if (count > 0) {
				infoToPrint.push(
					`You're about to delete ${statement.column.name} column in ${statement.column.table} table with ${count} items`,
				);
				columnsToRemove.push(`${statement.column.table}_${statement.column.name}`);
				shouldAskForApprove = true;
			}
		} else if (statement.type === 'drop_schema') {
			const escapedSchema = statement.name.replaceAll("'", "''");
			const rows = await db.query<{ count: string | number }>(
				`select count(*) as count from information_schema.tables where table_schema = '${escapedSchema}';`,
			);
			const count = Number(rows[0]?.count ?? 0);
			if (count > 0) {
				infoToPrint.push(`You're about to delete ${statement.name} schema with ${count} tables`);
				schemasToRemove.push(statement.name);
				shouldAskForApprove = true;
			}
		} else if (statement.type === 'alter_column' && statement.diff.type) {
			const count = await countRows(db, statement.to.schema, statement.to.table);
			if (count > 0) {
				infoToPrint.push(`You're about to change ${statement.to.name} column type with ${count} items`);
				statementsToExecute.push(`truncate table ${quotedTable(statement.to.schema, statement.to.table)} cascade;`);
				tablesToTruncate.push(statement.to.table);
				shouldAskForApprove = true;
			}
		} else if (
			statement.type === 'add_column'
			&& statement.column.notNull
			&& (statement.column.default === null || statement.column.default === undefined)
		) {
			const count = await countRows(db, statement.column.schema, statement.column.table);
			if (count > 0) {
				infoToPrint.push(
					`You're about to add not-null ${statement.column.name} column without a default to a table with ${count} items`,
				);
				statementsToExecute.push(
					`truncate table ${quotedTable(statement.column.schema, statement.column.table)} cascade;`,
				);
				tablesToTruncate.push(statement.column.table);
				shouldAskForApprove = true;
			}
		} else if (statement.type === 'drop_pk' || statement.type === 'alter_pk') {
			const count = await countRows(db, statement.pk.schema, statement.pk.table);
			if (count > 0) {
				infoToPrint.push(`You're about to change ${statement.pk.table} primary key`);
				tablesToTruncate.push(statement.pk.table);
				shouldAskForApprove = true;
			}
		} else if (statement.type === 'add_unique' && selectResolver) {
			const count = await countRows(db, statement.unique.schema, statement.unique.table);
			if (count > 0) {
				const { data } = await selectResolver({
					entity: {
						type: 'createUniqueConstraint',
						name: statement.unique.name,
						count,
						tableName: statement.unique.table,
					},
					items: ['no', 'yes'],
				});
				if (data.index === 1) {
					statementsToExecute.push(
						`truncate table ${quotedTable(statement.unique.schema, statement.unique.table)} cascade;`,
					);
					tablesToTruncate.push(statement.unique.table);
					shouldAskForApprove = true;
				}
			}
		}

		statementsToExecute.push(...fromJson([statement]).sqlStatements);
	}

	return {
		statementsToExecute: [...new Set(statementsToExecute)],
		shouldAskForApprove,
		infoToPrint,
		matViewsToRemove: [...new Set(matViewsToRemove)],
		columnsToRemove: [...new Set(columnsToRemove)],
		schemasToRemove: [...new Set(schemasToRemove)],
		tablesToTruncate: [...new Set(tablesToTruncate)],
		tablesToRemove: [...new Set(tablesToRemove)],
	};
};
