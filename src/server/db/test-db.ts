/*
 * A fresh in-memory PGlite per test, with every migration in `./drizzle`
 * applied. Tests that use it need `// @vitest-environment node`.
 *
 *   const t = await createTestDb();
 *   afterEach(() => t.close());
 *   await t.db.insert(users).values({}).returning();
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_FOLDER, schema, type Db } from "./client";

export type TestDb = {
  db: Db;
  client: PGlite;
  close: () => Promise<void>;
};

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite(); // no dataDir: in memory, gone on close
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Db, client, close: () => client.close() };
}
