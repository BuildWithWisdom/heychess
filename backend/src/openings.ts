// Embedded opening book (ECO-style). SAN sequences in chess.js format.
// Matcher takes the LONGEST prefix match, so specific lines beat generics.
// Kept to common club lines on purpose: offline, instant, no dependency.

export type OpeningLine = { name: string; sans: string[] };

export const OPENING_LINES: OpeningLine[] = [
  // --- Open games (1.e4 e5) ---
  { name: "Ruy Lopez: Closed", sans: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O"] },
  { name: "Ruy Lopez: Berlin Defense", sans: ["e4", "e5", "Nf3", "Nc6", "Bb5", "Nf6"] },
  { name: "Ruy Lopez", sans: ["e4", "e5", "Nf3", "Nc6", "Bb5"] },
  { name: "Italian Game: Evans Gambit", sans: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "b4"] },
  { name: "Italian Game: Giuoco Piano", sans: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"] },
  { name: "Italian Game: Two Knights", sans: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6"] },
  { name: "Italian Game", sans: ["e4", "e5", "Nf3", "Nc6", "Bc4"] },
  { name: "Scotch Gambit", sans: ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Bc4"] },
  { name: "Scotch Game", sans: ["e4", "e5", "Nf3", "Nc6", "d4"] },
  { name: "Four Knights Game", sans: ["e4", "e5", "Nf3", "Nc6", "Nc3", "Nf6"] },
  { name: "Philidor Defense", sans: ["e4", "e5", "Nf3", "d6"] },
  { name: "Petrov's Defense", sans: ["e4", "e5", "Nf3", "Nf6"] },
  { name: "Vienna Game", sans: ["e4", "e5", "Nc3"] },
  { name: "King's Gambit", sans: ["e4", "e5", "f4"] },
  { name: "King's Pawn Opening", sans: ["e4", "e5"] },
  // --- Sicilian (1.e4 c5) ---
  { name: "Sicilian Defense: Najdorf", sans: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"] },
  { name: "Sicilian Defense: Dragon", sans: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "g6"] },
  { name: "Sicilian Defense: Classical", sans: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "Nc6"] },
  { name: "Sicilian Defense: Scheveningen", sans: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "e6"] },
  { name: "Sicilian Defense: Sveshnikov", sans: ["e4", "c5", "Nf3", "Nc6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "e5"] },
  { name: "Sicilian Defense: Alapin", sans: ["e4", "c5", "c3"] },
  { name: "Sicilian Defense: Smith-Morra Gambit", sans: ["e4", "c5", "d4"] },
  { name: "Sicilian Defense: Closed", sans: ["e4", "c5", "Nc3"] },
  { name: "Sicilian Defense", sans: ["e4", "c5"] },
  // --- French / Caro / Pirc / Scandinavian / Alekhine ---
  { name: "French Defense: Winawer", sans: ["e4", "e6", "d4", "d5", "Nc3", "Bb4"] },
  { name: "French Defense: Tarrasch", sans: ["e4", "e6", "d4", "d5", "Nd2"] },
  { name: "French Defense: Advance", sans: ["e4", "e6", "d4", "d5", "e5"] },
  { name: "French Defense: Exchange", sans: ["e4", "e6", "d4", "d5", "exd5"] },
  { name: "French Defense: Steinitz", sans: ["e4", "e6", "d4", "d5", "Nc3", "Nf6"] },
  { name: "French Defense", sans: ["e4", "e6"] },
  { name: "Caro-Kann: Main Line", sans: ["e4", "c6", "d4", "d5", "Nc3", "dxe4", "Nxe4", "Bf5"] },
  { name: "Caro-Kann: Advance", sans: ["e4", "c6", "d4", "d5", "e5"] },
  { name: "Caro-Kann: Exchange", sans: ["e4", "c6", "d4", "d5", "exd5", "cxd5"] },
  { name: "Caro-Kann Defense", sans: ["e4", "c6"] },
  { name: "Pirc Defense", sans: ["e4", "d6", "d4", "Nf6", "Nc3", "g6"] },
  { name: "Modern Defense", sans: ["e4", "g6"] },
  { name: "Owen's Defense", sans: ["e4", "b6"] },
  { name: "Scandinavian Defense", sans: ["e4", "d5"] },
  { name: "Alekhine Defense", sans: ["e4", "Nf6"] },
  { name: "King's Pawn Opening", sans: ["e4"] },
  // --- Queen pawn games ---
  { name: "Queen's Gambit Declined: Orthodox", sans: ["d4", "d5", "c4", "e6", "Nc3", "Nf6", "Bg5", "Be7"] },
  { name: "Queen's Gambit Declined", sans: ["d4", "d5", "c4", "e6"] },
  { name: "Slav Defense", sans: ["d4", "d5", "c4", "c6"] },
  { name: "Queen's Gambit Accepted", sans: ["d4", "d5", "c4", "dxc4"] },
  { name: "Veresov Attack", sans: ["d4", "d5", "Nc3", "Nf6", "Bg5"] },
  { name: "London System", sans: ["d4", "d5", "Bf4"] },
  { name: "Colle System", sans: ["d4", "d5", "Nf3", "Nf6", "e3"] },
  { name: "London System", sans: ["d4", "Nf6", "Bf4"] },
  { name: "Trompowsky Attack", sans: ["d4", "Nf6", "Bg5"] },
  { name: "Catalan Opening", sans: ["d4", "Nf6", "c4", "e6", "g3"] },
  { name: "Nimzo-Indian Defense", sans: ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4"] },
  { name: "Queen's Indian Defense", sans: ["d4", "Nf6", "c4", "e6", "Nf3", "b6"] },
  { name: "Grünfeld Defense", sans: ["d4", "Nf6", "c4", "g6", "Nc3", "d5"] },
  { name: "King's Indian Defense", sans: ["d4", "Nf6", "c4", "g6"] },
  { name: "Benoni Defense", sans: ["d4", "Nf6", "c4", "c5"] },
  { name: "Dutch Defense", sans: ["d4", "f5"] },
  { name: "Queen's Pawn Opening", sans: ["d4"] },
  // --- Flank openings ---
  { name: "English Opening: King's English", sans: ["c4", "e5"] },
  { name: "English Opening", sans: ["c4"] },
  { name: "Réti Opening", sans: ["Nf3", "d5", "c4"] },
  { name: "King's Indian Attack", sans: ["Nf3", "d5", "g3"] },
  { name: "Bird's Opening", sans: ["f4"] },
];

export type IdentifiedOpening = { name: string; bookPly: number };

export function identifyOpening(gameSans: string[]): IdentifiedOpening {
  let best: IdentifiedOpening = { name: "Unknown Opening", bookPly: 0 };
  for (const line of OPENING_LINES) {
    if (line.sans.length <= best.bookPly) continue;
    if (line.sans.length > gameSans.length) continue;
    let ok = true;
    for (let i = 0; i < line.sans.length; i++) {
      if (gameSans[i] !== line.sans[i]) {
        ok = false;
        break;
      }
    }
    if (ok) best = { name: line.name, bookPly: line.sans.length };
  }
  return best;
}
