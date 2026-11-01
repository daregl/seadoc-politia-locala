FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps apps
RUN npm ci
RUN npm run build
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100 STORAGE_DIR=/data/files
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4100
USER node
CMD ["node", "apps/api/dist/src/main.js"]
