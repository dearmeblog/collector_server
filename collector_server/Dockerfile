FROM mcr.microsoft.com/playwright:v1.62.0-noble

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000
CMD ["node", "src/server.js"]
