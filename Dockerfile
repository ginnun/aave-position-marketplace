# One image that serves the interface and the read API together.
# Build it from the repository root:  docker build -t position-market .
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN npm ci --workspaces --include-workspace-root --ignore-scripts
COPY . .
RUN node web/scripts/copy-deployments.mjs && npm run -w web build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --workspace server --ignore-scripts --omit=dev
COPY server/ server/
COPY shared/ shared/
COPY deploy/ deploy/
COPY --from=build /app/web/dist web/dist
COPY deploy-stack/serve.js serve.js
EXPOSE 8787
CMD ["node", "serve.js"]
