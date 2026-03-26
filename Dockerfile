# ── Stage 1: Build ──
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Production ──
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache tini curl

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY prompts/ ./prompts/
COPY config/ ./config/

RUN mkdir -p /app/data /app/data/instances

USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
