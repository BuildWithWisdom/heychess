import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
// One row per Chess.com / Lichess / imported game.
// id = canonical game URL (chess.com) or generated id for imports.
// No auth yet: keyed by username string (e.g. "aguowisdom").
export const games = sqliteTable("games", {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    opponent: text("opponent").notNull(),
    result: text("result").notNull(), // win | loss | draw
    timeControl: text("time_control").notNull(),
    timeClass: text("time_class"),
    date: integer("date").notNull(), // unix ms
    source: text("source").notNull().default("chesscom"),
    pgn: text("pgn"),
    chesscomWhiteAccuracy: real("chesscom_white_accuracy"),
    chesscomBlackAccuracy: real("chesscom_black_accuracy"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
});
// One row per analyzed game. Written once after Stockfish + LLM finish.
// Read by the Games list so the Accuracy column never re-computes.
export const gameAnalyses = sqliteTable("game_analyses", {
    gameId: text("game_id")
        .primaryKey()
        .references(() => games.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    accuracy: real("accuracy").notNull(),
    userColor: text("user_color"), // w | b | null
    depth: integer("depth").notNull(),
    evals: text("evals").notNull(), // JSON string of MoveEval[]
    notes: text("notes"), // JSON string Record<ply, string>
    takeaways: text("takeaways"), // JSON string string[]
    summary: text("summary"),
    analyzedAt: integer("analyzed_at").notNull(),
});
// Last successful Chess.com sync per username.
// Powers "last synced 2 hours ago" in the design.
export const syncState = sqliteTable("sync_state", {
    username: text("username").primaryKey(),
    lastSyncedAt: integer("last_synced_at").notNull(),
    gamesCount: integer("games_count").notNull().default(0),
});
// ---- Better Auth tables (email+password v1) ----
// Managed by Better Auth via drizzleAdapter(provider: "sqlite").
// Do not rename: adapter maps `user/session/account/verification` by property name.
export const user = sqliteTable("user", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" })
        .notNull()
        .$defaultFn(() => false),
    image: text("image"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .$defaultFn(() => new Date()),
});
export const session = sqliteTable("session", {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
});
export const account = sqliteTable("account", {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
        mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
        mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const verification = sqliteTable("verification", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
});
