# Stage 1: Build
# Node 20 is required by next@16 (engines >=20.9.0) and prisma@7 (engines ^20.19).
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies from the lockfile so builds are deterministic.
COPY package*.json ./
RUN npm ci

COPY . .
# Generate the Prisma client. Prisma 7 reads connection settings from
# prisma.config.ts at runtime, so DATABASE_URL is not required here.
RUN npx prisma generate
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# next.config.ts sets output: 'standalone'; copy the trimmed bundle.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Prisma client artifacts ship with @prisma/client inside .next/standalone's
# node_modules, but the schema file is read at startup for some operations.
COPY --from=builder /app/prisma ./prisma

EXPOSE 8080
CMD ["node", "server.js"]
