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

// One migrated template per test worker; each test gets a clone of it.
// Cloning is about 4x faster than a fresh PGlite plus migrations, which keeps
// DB tests inside their timeouts when the whole suite runs in parallel.
let template: Promise<PGlite> | undefined;

function migratedTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const client = new PGlite(); // no dataDir: in memory
    await migrate(drizzle({ client, schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    return client;
  })();
  return template;
}

export async function createTestDb(): Promise<TestDb> {
  const client = (await (await migratedTemplate()).clone()) as PGlite; // gone on close
  const db = drizzle({ client, schema });
  return { db: db as unknown as Db, client, close: () => client.close() };
}
