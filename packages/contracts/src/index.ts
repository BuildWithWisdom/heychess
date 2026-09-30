import { z } from "zod";

// Shared API agreement. Backend validates, web renders. No logic here.

export const GameResultSchema = z.enum(["win", "loss", "draw"]);
export type GameResult = z.infer<typeof GameResultSchema>;

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
});
export type GameAnalysis = z.infer<typeof GameAnalysisSchema>;

export const ParsedMoveSchema = z.object({
  ply: z.number(),
  moveNo: z.number(),
  color: z.enum(["w", "b"]),
  san: z.string(),
  fen: z.string(),
});
export type ParsedMove = z.infer<typeof ParsedMoveSchema>;

export const OpeningInfoSchema = z.object({
  name: z.string(), // e.g. "Sicilian Defense"
  bookPly: z.number(), // plies matching theory; <= this ply is a "book move"
});
export type OpeningInfo = z.infer<typeof OpeningInfoSchema>;

export const GameDetailSchema = z.object({
  initialFen: z.string(),
  moves: z.array(ParsedMoveSchema),
  opening: OpeningInfoSchema.optional(),
});
export type GameDetail = z.infer<typeof GameDetailSchema>;
