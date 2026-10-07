import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { getDb } from "./db/client.ts";
import * as schema from "./db/schema.ts";
const db = getDb();
if (!db) {
    throw new Error("Database not configured. Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN in backend/.env");
}
export const auth = betterAuth({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3001",
    trustedOrigins: ["http://localhost:5173"],
    database: drizzleAdapter(db, {
        provider: "sqlite",
        schema,
    }),
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: false,
        autoSignIn: true,
        minPasswordLength: 8,
    },
    session: {
        // cookieCache disabled so a user deleted from the DB is detected
        // immediately: every useSession() validates against the server
        // instead of trusting a 7-day client-side cookie.
        cookieCache: {
            enabled: false,
        },
    },
    advanced: {
        database: {
            generateId: () => crypto.randomUUID(),
        },
    },
});
