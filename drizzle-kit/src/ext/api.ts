import type { MigrationConfig, MigratorInitFailResponse } from 'drizzle-orm/migrator';
import type { Pool, PoolClient } from 'pg';
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
import { createDDL, interimToDDL } from '../dialects/postgres/ddl';
import { ddlDiff } from '../dialects/postgres/diff';
import { fromDatabaseForDrizzle } from '../dialects/postgres/introspect';
import type { JsonStatement } from '../dialects/postgres/statements';
import { prepareEntityFilter } from '../dialects/pull-utils';
import type { DB, Proxy } from '../utils';
import '../@types/utils';

type Queryable = Pool | PoolClient;

export type DrizzlePgDB = DB & {
	proxy: Proxy;
	migrate: (config: string | MigrationConfig) => Promise<void | MigratorInitFailResponse>;
};

export type PreparePgDBOptions = {
	queryConcurrency?: number;
};

export type DrizzlePgDBIntrospectSchema = InterimSchema | LegacyEmptyPgSchema;

type LegacyEmptyPgSchema = {
	version: string;
	dialect: 'postgresql';
	id: string;
	prevId: string;
	tables: Record<string, unknown>;
	enums: Record<string, unknown>;
	schemas: Record<string, unknown>;
	policies: Record<string, unknown>;
	roles: Record<string, unknown>;
	sequences: Record<string, unknown>;
	views: Record<string, unknown>;
	_meta: Record<string, unknown>;
};

type Named = { name: string; schema?: string; table?: string };
type RenamePromptItem<T extends Named> = { from: T; to: T };
type LegacyResolverInput<T extends Named> = {
	created: T[];
	deleted: T[];
	schema?: string;
	tableName?: string;
};
type LegacyResolverOutput<T extends Named> = {
	created: T[];
	deleted: T[];
	renamed?: RenamePromptItem<T>[];
	renamedOrMoved?: RenamePromptItem<T>[];
	moved?: { name: string; schemaFrom: string; schemaTo: string }[];
};
type LegacyResolver<T extends Named = any> = (input: LegacyResolverInput<T>) => Promise<LegacyResolverOutput<T>>;

const defaultMigrationsConfig = {
	schema: 'drizzle',
	table: '__drizzle_migrations',
};

const passthroughResolver: LegacyResolver = async ({ created, deleted }) => {
	return { created, deleted, renamed: [] };
};

export const schemasResolver = passthroughResolver;
export const enumsResolver = passthroughResolver;
export const sequencesResolver = passthroughResolver;
export const policyResolver = passthroughResolver;
export const indPolicyResolver = passthroughResolver;
export const roleResolver = passthroughResolver;
export const tablesResolver = passthroughResolver;
export const columnsResolver = passthroughResolver;
export const viewsResolver = passthroughResolver;

export type ResolverInput<T extends Named = Named> = LegacyResolverInput<T>;
export type ColumnsResolverInput = LegacyResolverInput<Column>;
export type PolicyResolverInput = LegacyResolverInput<Policy>;
export type TablePolicyResolverInput = LegacyResolverInput<Policy>;
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

function createConcurrencyLimiter(concurrency?: number) {
	if (concurrency === undefined) {
		return <T>(fn: () => Promise<T>) => fn();
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

	return <T>(fn: () => Promise<T>) => {
		return new Promise<T>((resolve, reject) => {
			queue.push(() => {
				Promise.resolve()
					.then(fn)
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
		if (typeId === pg.types.builtins.TIMESTAMPTZ) {
			return (val: string) => val;
		}
		if (typeId === pg.types.builtins.TIMESTAMP) {
			return (val: string) => val;
		}
		if (typeId === pg.types.builtins.DATE) {
			return (val: string) => val;
		}
		if (typeId === pg.types.builtins.INTERVAL) {
			return (val: string) => val;
		}

		return pg.types.getTypeParser(typeId, format);
	};

	const db = drizzle(pool as any);
	const limitQuery = createConcurrencyLimiter(options.queryConcurrency);
	const queryable = pool as { query: (config: unknown) => Promise<{ rows: any[] }> };
	const types = { getTypeParser };

	const query = async <T extends any = any>(sql: string, params?: any[]): Promise<T[]> => {
		const result = await limitQuery(() => {
			return queryable.query({
				text: sql,
				values: params ?? [],
				types,
			});
		});
		return result.rows;
	};

	const proxy: Proxy = async (params) => {
		const result = await limitQuery(() => {
			return queryable.query({
				text: params.sql,
				values: params.params,
				...(params.mode === 'array' && { rowMode: 'array' }),
				types,
			});
		});
		return result.rows;
	};

	const migrateFn = async (config: string | MigrationConfig) => {
		return migrate(db, config as MigrationConfig);
	};

	return { query, proxy, migrate: migrateFn };
};

export const introspectPgDB = async (
	db: DrizzlePgDB,
	filters: string[],
	schemaFilters: string[],
): Promise<InterimSchema> => {
	const filter = prepareEntityFilter('postgresql', {
		tables: filters,
		schemas: schemaFilters,
		entities: undefined,
		extensions: [],
	}, []);

	return fromDatabaseForDrizzle(db, filter, () => {}, defaultMigrationsConfig);
};

function isDDL(schema: unknown): schema is PostgresDDL {
	return typeof schema === 'object' && schema !== null && 'entities' in schema;
}

function isInterimSchema(schema: unknown): schema is InterimSchema {
	return typeof schema === 'object'
		&& schema !== null
		&& Array.isArray((schema as InterimSchema).tables)
		&& Array.isArray((schema as InterimSchema).columns);
}

export const pgSchema = {
	parse: (schema: DrizzlePgDBIntrospectSchema) => schema,
};

export const squashPgScheme = (
	schema: DrizzlePgDBIntrospectSchema | PostgresDDL,
	_mode?: 'default' | 'push',
): PostgresDDL => {
	if (isDDL(schema)) {
		return schema;
	}

	if (!isInterimSchema(schema)) {
		return createDDL();
	}

	const { ddl, errors } = interimToDDL(schema);
	if (errors.length > 0) {
		throw new Error(`Failed to convert Postgres schema: ${errors.join('\n')}`);
	}

	return ddl;
};

function movedToRenamed<T extends Named>(
	moved: { name: string; schemaFrom: string; schemaTo: string },
	created: T[],
	deleted: T[],
): RenamePromptItem<T> {
	const from = deleted.find((item) => item.name === moved.name && (item.schema ?? 'public') === moved.schemaFrom)
		?? ({ name: moved.name, schema: moved.schemaFrom } as T);
	const to = created.find((item) => item.name === moved.name && (item.schema ?? 'public') === moved.schemaTo)
		?? ({ name: moved.name, schema: moved.schemaTo } as T);

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

		const renamedOrMoved = [
			...(result.renamed ?? []),
			...(result.renamedOrMoved ?? []),
			...(result.moved ?? []).map((move) => movedToRenamed(move, created, deleted)),
		];

		return {
			created: result.created,
			deleted: result.deleted,
			renamedOrMoved,
		};
	};
}

const noOpV1Resolver: Resolver<any> = async ({ created, deleted }) => {
	return { created, deleted, renamedOrMoved: [] };
};

export const applyPgSnapshotsDiff = async (
	targetSchema: PostgresDDL,
	sourceSchema: PostgresDDL,
	schemasResolverArg: LegacyResolver<Schema>,
	enumsResolverArg: LegacyResolver<Enum>,
	sequencesResolverArg: LegacyResolver<Sequence>,
	policyResolverArg: LegacyResolver<Policy>,
	_indPolicyResolverArg: LegacyResolver<any>,
	roleResolverArg: LegacyResolver<Role>,
	tablesResolverArg: LegacyResolver<PostgresEntities['tables']>,
	columnsResolverArg: LegacyResolver<Column>,
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
		adaptResolver(policyResolverArg),
		adaptResolver(roleResolverArg),
		noOpV1Resolver as Resolver<Privilege>,
		adaptResolver(tablesResolverArg),
		adaptResolver(columnsResolverArg),
		adaptResolver(viewsResolverArg),
		noOpV1Resolver as Resolver<UniqueConstraint>,
		noOpV1Resolver as Resolver<Index>,
		noOpV1Resolver as Resolver<CheckConstraint>,
		noOpV1Resolver as Resolver<PrimaryKey>,
		noOpV1Resolver as Resolver<ForeignKey>,
		mode,
	);
};

function quotedIdentifier({ schema, name }: { schema?: string; name: string }) {
	return schema && schema !== 'public' ? `"${schema}"."${name}"` : `"${name}"`;
}

async function maybeAddUniqueTruncateStatement({
	db,
	statement,
	selectResolver,
}: {
	db: DB;
	statement: Extract<JsonStatement, { type: 'add_unique' }>;
	selectResolver?: (input: SelectResolverInput) => Promise<SelectResolverOutput>;
}) {
	if (!selectResolver) {
		return;
	}

	const unique = statement.unique;
	const tableName = quotedIdentifier({ schema: unique.schema, name: unique.table });
	const res = await db.query<{ count: string | number }>(`select count(*) as count from ${tableName}`);
	const count = Number(res[0]?.count ?? 0);
	if (count <= 0) {
		return;
	}

	const { data } = await selectResolver({
		entity: {
			type: 'createUniqueConstraint',
			name: unique.name,
			count,
			tableName: unique.table,
		},
		items: ['no', 'yes'],
	});

	if (data?.index !== 1) {
		return;
	}

	return {
		statement: `truncate table ${tableName} cascade;`,
		table: unique.table,
	};
}

export const pgSuggestions = async (
	db: DB,
	statements: JsonStatement[],
	selectResolver?: (input: SelectResolverInput) => Promise<SelectResolverOutput>,
) => {
	const { suggestions } = await import('../cli/commands/push-postgres');
	const hints = await suggestions(db, statements);
	const { sqlStatements } = fromJson(statements);

	const statementsToExecute = hints
		.map((hint) => hint.statement)
		.filter((statement): statement is string => typeof statement !== 'undefined');
	const infoToPrint = hints.map((hint) => hint.hint);
	const matViewsToRemove: string[] = [];
	const columnsToRemove: string[] = [];
	const schemasToRemove: string[] = [];
	const tablesToTruncate: string[] = [];
	const tablesToRemove: string[] = [];

	for (const statement of statements) {
		if (statement.type === 'drop_table') {
			tablesToRemove.push(statement.table.name);
		} else if (statement.type === 'drop_view' && statement.view.materialized) {
			matViewsToRemove.push(statement.view.name);
		} else if (statement.type === 'drop_column') {
			columnsToRemove.push(`${statement.column.table}_${statement.column.name}`);
		} else if (statement.type === 'drop_schema') {
			schemasToRemove.push(statement.name);
		} else if (statement.type === 'alter_column' && statement.diff.type) {
			tablesToTruncate.push(statement.to.table);
		} else if (statement.type === 'add_column' && statement.column.notNull && !statement.column.default) {
			tablesToTruncate.push(statement.column.table);
		} else if (statement.type === 'add_unique') {
			const truncate = await maybeAddUniqueTruncateStatement({ db, statement, selectResolver });
			if (truncate) {
				statementsToExecute.push(truncate.statement);
				tablesToTruncate.push(truncate.table);
			}
		}
	}

	return {
		statementsToExecute: [...new Set([...statementsToExecute, ...sqlStatements])],
		shouldAskForApprove: infoToPrint.length > 0 || tablesToTruncate.length > 0,
		infoToPrint,
		matViewsToRemove: [...new Set(matViewsToRemove)],
		columnsToRemove: [...new Set(columnsToRemove)],
		schemasToRemove: [...new Set(schemasToRemove)],
		tablesToTruncate: [...new Set(tablesToTruncate)],
		tablesToRemove: [...new Set(tablesToRemove)],
	};
};
