# Stage 1: Build
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Ensure Prisma client is generated
RUN npx prisma generate
RUN npm run build

# Stage 2: Runtime
FROM node:18-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# The standalone output includes only the necessary node_modules
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Final entrypoint
EXPOSE 8080
CMD ["node", "server.js"]
