# Cloud Run backend image. Build context is the REPO ROOT:
#   docker build -f Dockerfile -t heychess .
#   gcloud run deploy heychess --source . --region us-central1 ...
# (gcloud --source deploy only picks up ./Dockerfile, so this file
# must stay at the root. backend/Dockerfile is a leftover — ignore it.)
FROM oven/bun:1-slim

WORKDIR /app

# Install workspace deps first for layer caching.
COPY package.json bun.lock ./
COPY backend/package.json ./backend/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN bun install --frozen-lockfile

# Copy sources (engine.ts spawns backend/bin/stockfish/...).
COPY packages/contracts ./packages/contracts
COPY backend ./backend
RUN chmod +x /app/backend/bin/stockfish/stockfish-ubuntu-x86-64

ENV NODE_ENV=production
# Cloud Run injects $PORT (defaults to 8080); index.ts already reads process.env.PORT.
EXPOSE 8080

WORKDIR /app/backend
CMD ["bun", "run", "src/index.ts"]
