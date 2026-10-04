import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per imported game, OWNED BY A USER.
// id = canonical game URL (chess.com) or generated id for imports.
// PK is (userId, id): two users linking the same chess.com account each
// get their own rows. chessHandle is only a label saying which external
// account the game came from — never identity, never access control.
export const games = sqliteTable(
  "games",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    chessHandle: text("chess_handle"),
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
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })]
);

// One row per analyzed game, owned by the same user. PK is
// (userId, gameId) so one user's notes never leak to another.
export const gameAnalyses = sqliteTable(
  "game_analyses",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    gameId: text("game_id").notNull(),
    accuracy: real("accuracy").notNull(),
    userColor: text("user_color"), // w | b | null
    depth: integer("depth").notNull(),
    evals: text("evals").notNull(), // JSON string of MoveEval[]
    notes: text("notes"), // JSON string Record<ply, string>
    takeaways: text("takeaways"), // JSON string string[]
    summary: text("summary"),
    analyzedAt: integer("analyzed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.gameId] })]
);

// Last successful Chess.com sync, one row per user.
// Powers "last synced 2 hours ago" in the design.
export const syncState = sqliteTable("sync_state", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  chessHandle: text("chess_handle"),
  lastSyncedAt: integer("last_synced_at").notNull(),
  gamesCount: integer("games_count").notNull().default(0),
});

export type GameRow = typeof games.$inferSelect;
export type GameAnalysisRow = typeof gameAnalyses.$inferSelect;

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
  // Linked chess accounts: one chess.com + one lichess handle per user.
  // Import and sync fetch from chess.com with these handles, but every
  // game row is owned via user_id — the handle is never access control.
  chessComUsername: text("chesscom_username"),
  lichessUsername: text("lichess_username"),
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
  createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(
    () => new Date()
  ),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(
    () => new Date()
  ),
});
