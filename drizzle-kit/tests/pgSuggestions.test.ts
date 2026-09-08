import { describe, expect, test, vi } from 'vitest';
import { pgSuggestions } from '../src/cli/commands/pgPushUtils';
import type { JsonStatement } from '../src/jsonStatements';

const dropTable: JsonStatement = {
	type: 'drop_table',
	tableName: 'users',
	schema: 'public',
};

describe('pgSuggestions row checks', () => {
	test('counts rows by default', async () => {
		const query = vi.fn().mockResolvedValue([{ count: '42' }]);

		const result = await pgSuggestions({ query }, [dropTable]);

		expect(query).toHaveBeenCalledWith('select count(*) as count from "public"."users"');
		expect(result.infoToPrint).toEqual(["· You're about to delete users table with 42 items"]);
	});

	test('can stop after the first row', async () => {
		const query = vi.fn().mockResolvedValue([{}]);

		const result = await pgSuggestions({ query }, [dropTable], undefined, 'exists');

		expect(query).toHaveBeenCalledWith('select 1 from "public"."users" limit 1');
		expect(result.infoToPrint).toEqual(["· You're about to delete users table with existing items"]);
	});
});
