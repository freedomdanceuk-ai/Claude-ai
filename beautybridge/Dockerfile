# For hosts other than Render (Railway, Fly.io, any VPS). Mount a volume at /var/data.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DATA_DIR=/var/data PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
