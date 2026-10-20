FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.production.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY examples/production-server.ts ./examples/production-server.ts
RUN npm run build:production && npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=builder --chown=node:node /app/build ./build
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build/examples/production-server.js"]
