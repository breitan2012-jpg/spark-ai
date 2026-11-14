FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 8787
ENV BREITAN_PORT=8787
ENV BREITAN_DATA_DIR=/app/data
CMD ["node", "server/index.js"]
