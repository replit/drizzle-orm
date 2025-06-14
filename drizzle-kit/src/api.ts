import { randomUUID } from 'crypto';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { MigrationConfig } from 'drizzle-orm/migrator';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { SingleStoreDriverDatabase } from 'drizzle-orm/singlestore';
import { Minimatch } from 'minimatch';
import {
	columnsResolver,
	enumsResolver,
	indPolicyResolver,
	mySqlViewsResolver,
	policyResolver,
	roleResolver,
	schemasResolver,
	sequencesResolver,
	sqliteViewsResolver,
	tablesResolver,
	viewsResolver,
} from './cli/commands/migrate';
import { pgPushIntrospect } from './cli/commands/pgIntrospect';
import { pgSuggestions } from './cli/commands/pgPushUtils';
import { updateUpToV6 as upPgV6, updateUpToV7 as upPgV7 } from './cli/commands/pgUp';
import { sqlitePushIntrospect } from './cli/commands/sqliteIntrospect';
import { logSuggestionsAndReturn } from './cli/commands/sqlitePushUtils';
import type { CasingType } from './cli/validations/common';
import { PostgresCredentials } from './cli/validations/postgres';
import { getTablesFilterByExtensions } from './extensions/getTablesFilterByExtensions';
import { originUUID } from './global';
import type { Config } from './index';
import { fillPgSnapshot } from './migrationPreparator';
import { MySqlSchema as MySQLSchemaKit, mysqlSchema, squashMysqlScheme } from './serializer/mysqlSchema';
import { generateMySqlSnapshot } from './serializer/mysqlSerializer';
import { prepareFromExports } from './serializer/pgImports';
import { PgSchema as PgSchemaKit, pgSchema, squashPgScheme } from './serializer/pgSchema';
import { fromDatabase, generatePgSnapshot } from './serializer/pgSerializer';
import {
	SingleStoreSchema as SingleStoreSchemaKit,
	singlestoreSchema,
	squashSingleStoreScheme,
} from './serializer/singlestoreSchema';
import { generateSingleStoreSnapshot } from './serializer/singlestoreSerializer';
import { SQLiteSchema as SQLiteSchemaKit, sqliteSchema, squashSqliteScheme } from './serializer/sqliteSchema';
import { generateSqliteSnapshot } from './serializer/sqliteSerializer';
import { ProxyParams } from './serializer/studio';
import type { DB, Proxy, SQLiteDB } from './utils';
export type DrizzleSnapshotJSON = PgSchemaKit;
export type DrizzleSQLiteSnapshotJSON = SQLiteSchemaKit;
export type DrizzleMySQLSnapshotJSON = MySQLSchemaKit;
export type DrizzleSingleStoreSnapshotJSON = SingleStoreSchemaKit;

// Replit

export const introspectPgDB = async (
	db: DB,
	filters: string[],
	schemaFilters: string[],
) => {
	const matchers = filters.map((it) => {
		return new Minimatch(it);
	});

	const filter = (tableName: string) => {
		if (matchers.length === 0) return true;

		let flags: boolean[] = [];

		for (let matcher of matchers) {
			if (matcher.negate) {
				if (!matcher.match(tableName)) {
					flags.push(false);
				}
			}

			if (matcher.match(tableName)) {
				flags.push(true);
			}
		}

		if (flags.length > 0) {
			return flags.every(Boolean);
		}
		return false;
	};

	const res = await fromDatabase(
		db,
		filter,
		schemaFilters,
		undefined,
		undefined,
		undefined
	);

	const schema = { id: originUUID, prevId: '', ...res } as PgSchemaKit;
	const { internal, ...schemaWithoutInternals } = schema;
	return schemaWithoutInternals;
};

export const preparePgDB = async (
	credentials: PostgresCredentials,
): Promise<
	DB & {
		proxy: Proxy;
		migrate: (config: string | MigrationConfig) => Promise<void>;
	}
> => {
		console.log(`Using 'pg' driver for database querying`);
		const { default: pg } = await import('pg');
		const { drizzle } = await import('drizzle-orm/node-postgres');
		const { migrate } = await import('drizzle-orm/node-postgres/migrator');

		const ssl = 'ssl' in credentials
			? credentials.ssl === 'prefer'
					|| credentials.ssl === 'require'
					|| credentials.ssl === 'allow'
				? { rejectUnauthorized: false }
				: credentials.ssl === 'verify-full'
				? {}
				: credentials.ssl
			: {};

		// Override pg default date parsers
		const types: { getTypeParser: typeof pg.types.getTypeParser } = {
			// @ts-ignore
			getTypeParser: (typeId, format) => {
				if (typeId === pg.types.builtins.TIMESTAMPTZ) {
					return (val) => val;
				}
				if (typeId === pg.types.builtins.TIMESTAMP) {
					return (val) => val;
				}
				if (typeId === pg.types.builtins.DATE) {
					return (val) => val;
				}
				if (typeId === pg.types.builtins.INTERVAL) {
					return (val) => val;
				}
				// @ts-ignore
				return pg.types.getTypeParser(typeId, format);
			},
		};

		const client = 'url' in credentials
			? new pg.Pool({ connectionString: credentials.url, max: 1 })
			: new pg.Pool({ ...credentials, ssl, max: 1 });

		const db = drizzle(client);
		const migrateFn = async (config: MigrationConfig) => {
			return migrate(db, config);
		};

		const query = async (sql: string, params?: any[]) => {
			const result = await client.query({
				text: sql,
				values: params ?? [],
				types,
			});
			return result.rows;
		};

		const proxy: Proxy = async (params: ProxyParams) => {
			const result = await client.query({
				text: params.sql,
				values: params.params,
				...(params.mode === 'array' && { rowMode: 'array' }),
				types,
			});
			return result.rows;
		};

		return { query, proxy, migrate: migrateFn };
}


export const getPgClientPool = async (
	targetCredentials: PostgresCredentials
) => {
	const { default: pg } = await import('pg');
	const pool = 'url' in targetCredentials
		? new pg.Pool({ connectionString: targetCredentials.url, max: 1 })
		: new pg.Pool({ ...targetCredentials, ssl: undefined, max: 1 });

	return pool;
};

export { applyPgSnapshotsDiff } from './snapshotsDiffer';
export {
	columnsResolver,
	enumsResolver,
	indPolicyResolver,
	pgSchema,
	pgSuggestions,
	policyResolver,
	roleResolver,
	schemasResolver,
	sequencesResolver,
	squashPgScheme,
	tablesResolver,
	viewsResolver
};

// Pg

export const generateDrizzleJson = (
	imports: Record<string, unknown>,
	prevId?: string,
	schemaFilters?: string[],
	casing?: CasingType,
): PgSchemaKit => {
	const prepared = prepareFromExports(imports);

	const id = randomUUID();

	const snapshot = generatePgSnapshot(
		prepared.tables,
		prepared.enums,
		prepared.schemas,
		prepared.sequences,
		prepared.roles,
		prepared.policies,
		prepared.views,
		prepared.matViews,
		casing,
		schemaFilters,
	);

	return fillPgSnapshot({
		serialized: snapshot,
		id,
		idPrev: prevId ?? originUUID,
	});
};

export const generateMigration = async (
	prev: DrizzleSnapshotJSON,
	cur: DrizzleSnapshotJSON,
) => {
	const { applyPgSnapshotsDiff } = await import('./snapshotsDiffer');

	const validatedPrev = pgSchema.parse(prev);
	const validatedCur = pgSchema.parse(cur);

	const squashedPrev = squashPgScheme(validatedPrev);
	const squashedCur = squashPgScheme(validatedCur);

	const { sqlStatements, _meta } = await applyPgSnapshotsDiff(
		squashedPrev,
		squashedCur,
		schemasResolver,
		enumsResolver,
		sequencesResolver,
		policyResolver,
		indPolicyResolver,
		roleResolver,
		tablesResolver,
		columnsResolver,
		viewsResolver,
		validatedPrev,
		validatedCur,
	);

	return sqlStatements;
};

export const pushSchema = async (
	imports: Record<string, unknown>,
	drizzleInstance: PgDatabase<any>,
	schemaFilters?: string[],
	tablesFilter?: string[],
	extensionsFilters?: Config['extensionsFilters'],
) => {
	const { applyPgSnapshotsDiff } = await import('./snapshotsDiffer');
	const { sql } = await import('drizzle-orm');
	const filters = (tablesFilter ?? []).concat(
		getTablesFilterByExtensions({ extensionsFilters, dialect: 'postgresql' }),
	);

	const db: DB = {
		query: async (query: string, params?: any[]) => {
			const res = await drizzleInstance.execute(sql.raw(query));
			return res.rows;
		},
	};

	const cur = generateDrizzleJson(imports);
	const { schema: prev } = await pgPushIntrospect(
		db,
		filters,
		schemaFilters ?? ['public'],
		undefined,
	);

	const validatedPrev = pgSchema.parse(prev);
	const validatedCur = pgSchema.parse(cur);

	const squashedPrev = squashPgScheme(validatedPrev, 'push');
	const squashedCur = squashPgScheme(validatedCur, 'push');

	const { statements } = await applyPgSnapshotsDiff(
		squashedPrev,
		squashedCur,
		schemasResolver,
		enumsResolver,
		sequencesResolver,
		policyResolver,
		indPolicyResolver,
		roleResolver,
		tablesResolver,
		columnsResolver,
		viewsResolver,
		validatedPrev,
		validatedCur,
		'push',
	);

	const { shouldAskForApprove, statementsToExecute, infoToPrint } = await pgSuggestions(db, statements);

	return {
		hasDataLoss: shouldAskForApprove,
		warnings: infoToPrint,
		statementsToExecute,
		apply: async () => {
			for (const dStmnt of statementsToExecute) {
				await db.query(dStmnt);
			}
		},
	};
};

// SQLite

export const generateSQLiteDrizzleJson = async (
	imports: Record<string, unknown>,
	prevId?: string,
	casing?: CasingType,
): Promise<SQLiteSchemaKit> => {
	const { prepareFromExports } = await import('./serializer/sqliteImports');

	const prepared = prepareFromExports(imports);

	const id = randomUUID();

	const snapshot = generateSqliteSnapshot(prepared.tables, prepared.views, casing);

	return {
		...snapshot,
		id,
		prevId: prevId ?? originUUID,
	};
};

export const generateSQLiteMigration = async (
	prev: DrizzleSQLiteSnapshotJSON,
	cur: DrizzleSQLiteSnapshotJSON,
) => {
	const { applySqliteSnapshotsDiff } = await import('./snapshotsDiffer');

	const validatedPrev = sqliteSchema.parse(prev);
	const validatedCur = sqliteSchema.parse(cur);

	const squashedPrev = squashSqliteScheme(validatedPrev);
	const squashedCur = squashSqliteScheme(validatedCur);

	const { sqlStatements } = await applySqliteSnapshotsDiff(
		squashedPrev,
		squashedCur,
		tablesResolver,
		columnsResolver,
		sqliteViewsResolver,
		validatedPrev,
		validatedCur,
	);

	return sqlStatements;
};

export const pushSQLiteSchema = async (
	imports: Record<string, unknown>,
	drizzleInstance: LibSQLDatabase<any>,
) => {
	const { applySqliteSnapshotsDiff } = await import('./snapshotsDiffer');
	const { sql } = await import('drizzle-orm');

	const db: SQLiteDB = {
		query: async (query: string, params?: any[]) => {
			const res = drizzleInstance.all<any>(sql.raw(query));
			return res;
		},
		run: async (query: string) => {
			return Promise.resolve(drizzleInstance.run(sql.raw(query))).then(
				() => {},
			);
		},
	};

	const cur = await generateSQLiteDrizzleJson(imports);
	const { schema: prev } = await sqlitePushIntrospect(db, []);

	const validatedPrev = sqliteSchema.parse(prev);
	const validatedCur = sqliteSchema.parse(cur);

	const squashedPrev = squashSqliteScheme(validatedPrev, 'push');
	const squashedCur = squashSqliteScheme(validatedCur, 'push');

	const { statements, _meta } = await applySqliteSnapshotsDiff(
		squashedPrev,
		squashedCur,
		tablesResolver,
		columnsResolver,
		sqliteViewsResolver,
		validatedPrev,
		validatedCur,
		'push',
	);

	const { shouldAskForApprove, statementsToExecute, infoToPrint } = await logSuggestionsAndReturn(
		db,
		statements,
		squashedPrev,
		squashedCur,
		_meta!,
	);

	return {
		hasDataLoss: shouldAskForApprove,
		warnings: infoToPrint,
		statementsToExecute,
		apply: async () => {
			for (const dStmnt of statementsToExecute) {
				await db.query(dStmnt);
			}
		},
	};
};

// MySQL

export const generateMySQLDrizzleJson = async (
	imports: Record<string, unknown>,
	prevId?: string,
	casing?: CasingType,
): Promise<MySQLSchemaKit> => {
	const { prepareFromExports } = await import('./serializer/mysqlImports');

	const prepared = prepareFromExports(imports);

	const id = randomUUID();

	const snapshot = generateMySqlSnapshot(prepared.tables, prepared.views, casing);

	return {
		...snapshot,
		id,
		prevId: prevId ?? originUUID,
	};
};

export const generateMySQLMigration = async (
	prev: DrizzleMySQLSnapshotJSON,
	cur: DrizzleMySQLSnapshotJSON,
) => {
	const { applyMysqlSnapshotsDiff } = await import('./snapshotsDiffer');

	const validatedPrev = mysqlSchema.parse(prev);
	const validatedCur = mysqlSchema.parse(cur);

	const squashedPrev = squashMysqlScheme(validatedPrev);
	const squashedCur = squashMysqlScheme(validatedCur);

	const { sqlStatements } = await applyMysqlSnapshotsDiff(
		squashedPrev,
		squashedCur,
		tablesResolver,
		columnsResolver,
		mySqlViewsResolver,
		validatedPrev,
		validatedCur,
	);

	return sqlStatements;
};

export const pushMySQLSchema = async (
	imports: Record<string, unknown>,
	drizzleInstance: MySql2Database<any>,
	databaseName: string,
) => {
	const { applyMysqlSnapshotsDiff } = await import('./snapshotsDiffer');
	const { logSuggestionsAndReturn } = await import(
		'./cli/commands/mysqlPushUtils'
	);
	const { mysqlPushIntrospect } = await import(
		'./cli/commands/mysqlIntrospect'
	);
	const { sql } = await import('drizzle-orm');

	const db: DB = {
		query: async (query: string, params?: any[]) => {
			const res = await drizzleInstance.execute(sql.raw(query));
			return res[0] as unknown as any[];
		},
	};
	const cur = await generateMySQLDrizzleJson(imports);
	const { schema: prev } = await mysqlPushIntrospect(db, databaseName, []);

	const validatedPrev = mysqlSchema.parse(prev);
	const validatedCur = mysqlSchema.parse(cur);

	const squashedPrev = squashMysqlScheme(validatedPrev);
	const squashedCur = squashMysqlScheme(validatedCur);

	const { statements } = await applyMysqlSnapshotsDiff(
		squashedPrev,
		squashedCur,
		tablesResolver,
		columnsResolver,
		mySqlViewsResolver,
		validatedPrev,
		validatedCur,
		'push',
	);

	const { shouldAskForApprove, statementsToExecute, infoToPrint } = await logSuggestionsAndReturn(
		db,
		statements,
		validatedCur,
	);

	return {
		hasDataLoss: shouldAskForApprove,
		warnings: infoToPrint,
		statementsToExecute,
		apply: async () => {
			for (const dStmnt of statementsToExecute) {
				await db.query(dStmnt);
			}
		},
	};
};

// SingleStore

export const generateSingleStoreDrizzleJson = async (
	imports: Record<string, unknown>,
	prevId?: string,
	casing?: CasingType,
): Promise<SingleStoreSchemaKit> => {
	const { prepareFromExports } = await import('./serializer/singlestoreImports');

	const prepared = prepareFromExports(imports);

	const id = randomUUID();

	const snapshot = generateSingleStoreSnapshot(prepared.tables, /* prepared.views, */ casing);

	return {
		...snapshot,
		id,
		prevId: prevId ?? originUUID,
	};
};

export const generateSingleStoreMigration = async (
	prev: DrizzleSingleStoreSnapshotJSON,
	cur: DrizzleSingleStoreSnapshotJSON,
) => {
	const { applySingleStoreSnapshotsDiff } = await import('./snapshotsDiffer');

	const validatedPrev = singlestoreSchema.parse(prev);
	const validatedCur = singlestoreSchema.parse(cur);

	const squashedPrev = squashSingleStoreScheme(validatedPrev);
	const squashedCur = squashSingleStoreScheme(validatedCur);

	const { sqlStatements } = await applySingleStoreSnapshotsDiff(
		squashedPrev,
		squashedCur,
		tablesResolver,
		columnsResolver,
		/* singleStoreViewsResolver, */
		validatedPrev,
		validatedCur,
		'push',
	);

	return sqlStatements;
};

export const pushSingleStoreSchema = async (
	imports: Record<string, unknown>,
	drizzleInstance: SingleStoreDriverDatabase<any>,
	databaseName: string,
) => {
	const { applySingleStoreSnapshotsDiff } = await import('./snapshotsDiffer');
	const { logSuggestionsAndReturn } = await import(
		'./cli/commands/singlestorePushUtils'
	);
	const { singlestorePushIntrospect } = await import(
		'./cli/commands/singlestoreIntrospect'
	);
	const { sql } = await import('drizzle-orm');

	const db: DB = {
		query: async (query: string) => {
			const res = await drizzleInstance.execute(sql.raw(query));
			return res[0] as unknown as any[];
		},
	};
	const cur = await generateSingleStoreDrizzleJson(imports);
	const { schema: prev } = await singlestorePushIntrospect(db, databaseName, []);

	const validatedPrev = singlestoreSchema.parse(prev);
	const validatedCur = singlestoreSchema.parse(cur);

	const squashedPrev = squashSingleStoreScheme(validatedPrev);
	const squashedCur = squashSingleStoreScheme(validatedCur);

	const { statements } = await applySingleStoreSnapshotsDiff(
		squashedPrev,
		squashedCur,
		tablesResolver,
		columnsResolver,
		/* singleStoreViewsResolver, */
		validatedPrev,
		validatedCur,
		'push',
	);

	const { shouldAskForApprove, statementsToExecute, infoToPrint } = await logSuggestionsAndReturn(
		db,
		statements,
		validatedCur,
		validatedPrev,
	);

	return {
		hasDataLoss: shouldAskForApprove,
		warnings: infoToPrint,
		statementsToExecute,
		apply: async () => {
			for (const dStmnt of statementsToExecute) {
				await db.query(dStmnt);
			}
		},
	};
};

export const upPgSnapshot = (snapshot: Record<string, unknown>) => {
	if (snapshot.version === '5') {
		return upPgV7(upPgV6(snapshot));
	}
	if (snapshot.version === '6') {
		return upPgV7(snapshot);
	}
	return snapshot;
};
