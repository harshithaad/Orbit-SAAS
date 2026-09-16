import "dotenv/config";
import { Client } from "pg";
import { execSync } from "node:child_process";

// Creates the test database (if missing) and applies migrations to it.
async function main() {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error("TEST_DATABASE_URL not set");
  const u = new URL(testUrl);
  const dbName = u.pathname.slice(1);
  u.pathname = "/postgres";

  const client = new Client({ connectionString: u.toString() });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`created database ${dbName}`);
  }
  await client.end();

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testUrl },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
