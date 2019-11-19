import 'jest-extended'
import { makeTestDatabase } from "./utils/make-test-database";

test('successful connection', async () => {
	const { database, cleanupHook } = await makeTestDatabase();

	const results = await database.query({ sql: 'SELECT 1;' });

	expect(Array.isArray(results)).toBeTrue()
	expect(results.length).toBe(1)

	await cleanupHook();
});
