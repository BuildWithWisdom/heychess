// Real ECO opening book: 3,815 named lines compiled from the lichess
// chess-openings dataset (github.com/lichess-org/chess-openings, a.tsv–e.tsv:
// ECO code / name / move sequence), parsed to SAN via chess.js.
// Matcher takes the LONGEST prefix match, so specific lines beat generics.
// Offline, instant, no dependency.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ECO_LINES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "eco-lines.json"), "utf8"));
export function identifyOpening(gameSans) {
    let best = null;
    for (const line of ECO_LINES) {
        if (line.s.length <= (best?.s.length ?? 0))
            continue;
        if (line.s.length > gameSans.length)
            continue;
        let ok = true;
        for (let i = 0; i < line.s.length; i++) {
            if (gameSans[i] !== line.s[i]) {
                ok = false;
                break;
            }
        }
        if (ok)
            best = line;
    }
    if (!best)
        return { name: "Unknown Opening", bookPly: 0, eco: null };
    return { name: best.n, bookPly: best.s.length, eco: best.e };
}
