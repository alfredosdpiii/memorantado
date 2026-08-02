# --- build stage ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# prune after build: drops devDeps without re-running scripts, keeping the
# compiled/downloaded better-sqlite3 binding intact for the runtime stage.
RUN npm run build && npm prune --omit=dev

# --- runtime stage ---
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY bin ./bin
RUN mkdir -p /data
EXPOSE 3789
# Binds 127.0.0.1 by design; hugo's compose shares the network namespace.
CMD ["node", "bin/memorantado.js"]
