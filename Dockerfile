# --- deps: install once, reused by build + runtime (server runs via tsx, no compile step) ---
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- dev: source bind-mounted in, node_modules baked into image (see docker-compose.dev.yml) ---
FROM deps AS dev
WORKDIR /app
COPY . .
EXPOSE 5173 4173
CMD ["pnpm", "dev"]

# --- build: bundle client → client/dist ---
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# --- runtime ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY --from=build /app/client/dist ./client/dist

EXPOSE 4173
CMD ["node_modules/.bin/tsx", "server/index.ts"]
