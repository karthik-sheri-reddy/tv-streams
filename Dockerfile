FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=7788
EXPOSE 7788

CMD ["node", "src/server.js"]
