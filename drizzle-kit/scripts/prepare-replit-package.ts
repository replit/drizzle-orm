import { readFile, writeFile } from 'node:fs/promises';

async function main() {
	const packagePath = 'dist/package.json';
	const parsed: unknown = JSON.parse(await readFile(packagePath, 'utf8'));

	if (typeof parsed !== 'object' || parsed === null || !('name' in parsed) || parsed.name !== 'drizzle-kit') {
		throw new Error('Expected the built drizzle-kit package manifest');
	}

	await writeFile(
		packagePath,
		`${JSON.stringify({ ...parsed, name: '@drizzle-team/drizzle-kit' }, null, '\t')}\n`,
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
