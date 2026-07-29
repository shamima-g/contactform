ARG NODE_VERSION=22.22.3-slim

# ============================================
# Stage 1: Dependencies Installation Stage
# ============================================

FROM node:${NODE_VERSION} AS dependencies
WORKDIR /app
COPY web/package.json web/package-lock.json web/.npmrc* ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --no-audit --no-fund --ignore-scripts

# ============================================
# Stage 2: Build Next.js application in standalone mode
# ============================================

FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY web/ .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Build-time public values. Anything starting with NEXT_PUBLIC_ is inlined into
# the browser bundle during `next build`, so it must be present HERE — passing it
# only at `docker run` is too late, the bundle is already built without it.
# Uncomment and add one ARG + ENV pair per NEXT_PUBLIC_ variable your project
# uses, then pass each with `docker build --build-arg NEXT_PUBLIC_...=...`.
# ARG NEXT_PUBLIC_API_BASE_URL
# ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

RUN npm run build

# ============================================
# Stage 3: Run Next.js application
# ============================================

FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=node:node /app/public ./public

RUN mkdir .next && chown node:node .next

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000
CMD ["node", "server.js"]
