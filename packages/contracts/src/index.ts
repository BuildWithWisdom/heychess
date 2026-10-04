import { z } from "zod";

// Shared API agreement. Backend validates, web renders. No logic here.

export const GameResultSchema = z.enum(["win", "loss", "draw"]);
export type GameResult = z.infer<typeof GameResultSchema>;

export const PlayerStatsSchema = z.object({
  username: z.string(),
  totalGames: z.number(),
  wins: z.number(),
  losses: z.number(),
  draws: z.number(),
  winRate: z.number(), // 0-100
});
export type PlayerStats = z.infer<typeof PlayerStatsSchema>;

export const GameSourceSchema = z.enum(["chesscom", "lichess", "pgn"]);
export type GameSource = z.infer<typeof GameSourceSchema>;

export const GameSchema = z.object({
  id: z.string(),
  opponent: z.string(),
  result: GameResultSchema,
  timeControl: z.string(), // e.g. "10+0 - Blitz"
  accuracy: z.number().min(0).max(100).optional(),
  date: z.string(), // ISO date
  source: GameSourceSchema,
  pgn: z.string().optional(),
});
export type Game = z.infer<typeof GameSchema>;

export const MoveVerdictSchema = z.enum(["best", "great", "brilliant", "good", "inaccuracy", "mistake", "blunder"]);
export type MoveVerdict = z.infer<typeof MoveVerdictSchema>;

export const MoveEvalSchema = z.object({
  ply: z.number(), // half-move index
  san: z.string(), // e.g. "Nf1"
  evalCp: z.number(), // stockfish score in centipawns, white perspective
  deltaCp: z.number().optional(), // eval loss vs best
  verdict: MoveVerdictSchema.optional(),
  bestSan: z.string().optional(), // e.g. "Bg5"
});
export type MoveEval = z.infer<typeof MoveEvalSchema>;

export const GameAnalysisSchema = z.object({
  gameId: z.string(),
  evals: z.array(MoveEvalSchema),
  accuracy: z.number().min(0).max(100),
  userColor: z.enum(["w", "b"]).optional(),
  // Stored-analysis extras: engine depth + coach output, so a game opened
  // twice is served from Turso instead of re-run.
  depth: z.number().optional(),
  notes: z.record(z.string(), z.string()).optional(),
  takeaways: z.array(z.string()).optional(),
  summary: z.string().optional(),
});
export type GameAnalysis = z.infer<typeof GameAnalysisSchema>;

export const ParsedMoveSchema = z.object({
  ply: z.number(),
  moveNo: z.number(),
  color: z.enum(["w", "b"]),
  san: z.string(),
  fen: z.string(),
  // Remaining clock for the mover AFTER the move, in seconds (from [%clk]).
  // Absent when the PGN has no clock comments.
  clockSecs: z.number().optional(),
});
export type ParsedMove = z.infer<typeof ParsedMoveSchema>;

export const OpeningInfoSchema = z.object({
  name: z.string(), // e.g. "Sicilian Defense"
  bookPly: z.number(), // plies matching theory; <= this ply is a "book move"
  eco: z.string().optional(), // e.g. "B94"
});
export type OpeningInfo = z.infer<typeof OpeningInfoSchema>;

export const GameDetailSchema = z.object({
  initialFen: z.string(),
  moves: z.array(ParsedMoveSchema),
  opening: OpeningInfoSchema.optional(),
  // Increment added after each move, in seconds (from [TimeControl "600+5"]).
  // Used with clockSecs to compute real time spent. Absent when unknown.
  incrementSecs: z.number().optional(),
  // Base clock in seconds (the "600" in "600+5"). Needed for first-move timing.
  baseSecs: z.number().optional(),
});
export type GameDetail = z.infer<typeof GameDetailSchema>;
