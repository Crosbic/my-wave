FROM node:26-bookworm AS builder

WORKDIR /build

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:26-bookworm

ENV NODE_ENV=production

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY --from=builder /build/dist ./dist

# База с токенами пользователей: монтируйте сюда volume, иначе она пропадёт при пересоздании контейнера
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

USER node

# Запуск напрямую через node, чтобы SIGTERM доходил до бота и он корректно завершал работу
CMD [ "node", "dist/index.js" ]
