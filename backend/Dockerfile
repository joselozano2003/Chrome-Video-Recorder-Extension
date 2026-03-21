FROM node:20-alpine

# FFmpeg is required for remuxing WebM → MP4
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

EXPOSE 3000

CMD ["node", "src/server.js"]
