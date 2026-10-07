const MODEL = "deepseek-v4.1-flash";
const BASE_URL = "https://maas.qwencloudapi.com/compatible-mode/v1";
async function postChat(body) {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey)
        throw new Error("DASHSCOPE_API_KEY not set");
    const bodyText = JSON.stringify(body);
    console.log(`[explain] POST ${BASE_URL}/chat/completions model=${MODEL} bytes=${bodyText.length}`);
    const started = Date.now();
    const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "*/*",
            "User-Agent": "HeyChess/0.1",
        },
        body: bodyText,
    });
    const raw = await res.text();
    console.log(`[explain] status=${res.status} in ${Date.now() - started}ms, body_len=${raw.length}`);
    try {
        const data = JSON.parse(raw);
        const choice = data.choices?.[0] ?? {};
        const msg = choice.message ?? {};
        const content = Array.isArray(msg.content)
            ? msg.content.map((p) => (typeof p === "string" ? p : p.text ?? "")).join("")
            : (msg.content ?? "");
        console.log(`[explain] finish=${choice.finish_reason ?? "?"} content_len=${String(content).length} reasoning_len=${String(msg.reasoning_content ?? "").length}`);
        console.log(`[explain] content_head=${String(content).slice(0, 500)}`);
    }
    catch {
        console.log(`[explain] raw=${raw.slice(0, 1200)}`);
    }
    return { status: res.status, raw };
}
function normalizeContent(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        return value
            .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
            .join("");
    }
    return "";
}
function shortSentence(s, maxWords = 20) {
    const one = s.split(/(?<=[.!?])\s+/)[0]?.trim() ?? s.trim();
    const words = one.split(/\s+/);
    return words.length > maxWords ? words.slice(0, maxWords).join(" ") : one;
}
function shortBullets(list, maxWords = 12) {
    return list.slice(0, 3).map((t) => {
        const words = t.trim().split(/\s+/);
        return words.length > maxWords ? words.slice(0, maxWords).join(" ") : t.trim();
    });
}
function tryParseNotesSummary(text) {
    // Strip markdown fences: ```json ... ``` or ``` ... ```
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [];
    if (fenced)
        candidates.push(fenced[1].trim());
    candidates.push(text.trim());
    // Also try every substring starting at a "notes" key: handles thinking
    // traces and prose-wrapped JSON where first "{" is not the answer.
    const notesIdx = text.indexOf('"notes"');
    if (notesIdx >= 0) {
        const brace = text.lastIndexOf("{", notesIdx);
        if (brace >= 0)
            candidates.push(text.slice(brace).trim());
    }
    for (const cand of candidates) {
        const start = cand.indexOf("{");
        if (start < 0)
            continue;
        // Try closing braces from last to first (max 20 tries) to tolerate
        // trailing prose / extra braces after the JSON object.
        const ends = [];
        for (let i = cand.length - 1; i > start && ends.length < 20; i--) {
            if (cand[i] === "}")
                ends.push(i);
        }
        for (const end of ends) {
            try {
                const parsed = JSON.parse(cand.slice(start, end + 1));
                if (parsed && (parsed.notes || parsed.summary)) {
                    const notes = {};
                    for (const [k, v] of Object.entries(parsed.notes ?? {}))
                        notes[Number(k)] = String(v);
                    const takeaways = Array.isArray(parsed.takeaways)
                        ? shortBullets(parsed.takeaways.map(String))
                        : [];
                    return {
                        notes,
                        summary: shortSentence(String(parsed.summary ?? "")),
                        takeaways,
                        nextSteps: shortSentence(String(parsed.nextSteps ?? "")),
                    };
                }
                // Parsed but no notes/summary: keep trying shorter slices.
            }
            catch {
                // try a shorter slice
            }
        }
    }
    return null;
}
function extractGameOutput(raw) {
    const data = JSON.parse(raw);
    const choice = data.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    // Content is the answer. Reasoning is chain-of-thought: only a fallback,
    // because the model sometimes drops the final JSON there when truncated.
    const content = normalizeContent(msg.content).trim();
    const reasoning = normalizeContent(msg.reasoning_content).trim();
    const fromContent = content ? tryParseNotesSummary(content) : null;
    if (fromContent)
        return fromContent;
    const fromReasoning = reasoning ? tryParseNotesSummary(reasoning) : null;
    if (fromReasoning)
        return fromReasoning;
    const finish = choice.finish_reason ?? "unknown";
    const tail = (content || reasoning).slice(-300);
    throw new Error(`no JSON object in response (finish=${finish} content_len=${content.length} reasoning_len=${reasoning.length} tail=${tail || raw.slice(0, 200)})`);
}
// ONE request per game: notes for every notable user move + overall summary.
export async function explainGame(input) {
    const started = Date.now();
    const player = input.userColor === "w" ? "White" : input.userColor === "b" ? "Black" : "unknown";
    const opponent = input.userColor === "w" ? "Black" : input.userColor === "b" ? "White" : "unknown";
    const lines = input.moves.map((m) => {
        const mover = m.ply % 2 === 1 ? "White" : "Black";
        const yours = player === "unknown" || mover === player;
        const side = yours ? "YOUR move" : "OPPONENT move";
        const praised = m.verdict === "best" || m.verdict === "brilliant" || m.verdict === "good";
        const detail = praised
            ? `praise this strong move (verdict=${m.verdict})`
            : `verdict=${m.verdict} (lost ${(m.deltaCp / 100).toFixed(1)} pawns), best=${m.bestSan ?? "unknown"}`;
        return `ply ${m.ply} (${m.moveNo}. ${m.san}, ${mover}, ${side}): ${detail}`;
    });
    const { status, raw } = await postChat({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 1500,
        // MaaS / DashScope OpenAI-compatible flag: the chess commentary is a
        // language task (Stockfish already did the search), so skip the 20k+
        // chars of board-simulation thinking that starves `content`.
        enable_thinking: false,
        response_format: { type: "json_object" },
        messages: [
            {
                role: "system",
                content: `You coach the ${player} player ("you"). The opponent is ${opponent}. ` +
                    "Each listed move is tagged YOUR move (played by the coached player) or OPPONENT move (played by their opponent). " +
                    "For YOUR moves speak directly ('you missed...', 'your bishop...'). " +
                    "For OPPONENT moves say 'your opponent' or 'they' — never 'you' — and explain what it means for the coached player " +
                    "(e.g. 'Your opponent missed... you're off the hook.' or 'Your opponent found the strongest reply...'). " +
                    "A piece belongs to whoever's color controls its square. " +
                    "Ground every claim in the game score and the engine facts given — never invent pieces or squares. " +
                    "For mistakes: sentence 1 the idea YOUR move misses, sentence 2 what the best move does differently. " +
                    "For praised moves: sentence 1 what makes it strong, sentence 2 the concrete threat or gain it creates. " +
                    "Bullets: concrete facts with correct ownership and move numbers. Match this voice: 'This move looks natural, but it doesn't address the real threat. " +
                    "You're missing a more active option.' Keep internal reasoning brief. Your FINAL answer in `content` must be ONLY a JSON object (no markdown, no prose): " +
                    "{\"notes\": {\"<ply>\": \"<sentence 1> <sentence 2>\\nWhy: <bullet 1>\\nWhy: <bullet 2>\"}, \"summary\": \"<1 sentence, max 20 words — the result in plain words>\", " +
                    "\"takeaways\": [\"<3 bullets, max 12 words each, concrete patterns from THIS game>\"], \"nextSteps\": \"<1 sentence, max 20 words of trainable advice>\"}. " +
                    "Keep summary/takeaways/nextSteps minimal — no move lists, no engine numbers there. " +
                    "Plain text, no markdown.",
            },
            {
                role: "user",
                content: `You coach ${player}. ` +
                    `Result: ${input.result} vs ${input.opponent} (${opponent}). Accuracy: ${input.accuracy}%.\n` +
                    `Full game score:\n${input.gameLine}\n` +
                    `Comment on these notable moves from BOTH sides, keyed by ply:\n${lines.join("\n")}`,
            },
        ],
    });
    if (status !== 200)
        throw new Error(`upstream ${status}: ${raw.slice(0, 300)}`);
    const out = extractGameOutput(raw);
    console.log(`[explain] done in ${Date.now() - started}ms, notes=${Object.keys(out.notes).length}`);
    return out;
}
