import "dotenv/config";

// Point the app at the test database for the whole test run.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL must be set (see .env.example)");
process.env.DATABASE_URL = url;
process.env.INVITE_SECRET ??= "test-invite-secret";
process.env.AUTH_SECRET ??= "test-auth-secret";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
