FROM node:22-slim

WORKDIR /app

# Libs de sistema exigidas pelo Chromium do @sparticuz (mesmo binário usado hoje
# no buildpack DO) + openssl para os engines do Prisma.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openssl \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 libglib2.0-0 \
    libx11-6 libxcb1 libxext6 \
    fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npx tsc

ENV NODE_ENV=production \
    MALLOC_ARENA_MAX=2 \
    UV_THREADPOOL_SIZE=4

# db push no boot preserva o comportamento atual (Prisma sem migrations, schema
# como source of truth). Heap cap 1536MB para o container de 2GiB do Cloud Run.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && exec node --expose-gc --max-old-space-size=1536 dist/server.js"]
