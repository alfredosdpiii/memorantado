# --- build stage ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY bin ./bin
RUN mkdir -p /data
EXPOSE 3789
# Binds 127.0.0.1 by design; hugo's compose shares the network namespace.
CMD ["node", "bin/memorantado.js"]
