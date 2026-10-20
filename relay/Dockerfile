# dsh-remote-control-relay — 公网 WebSocket 中继（哑管道）
# 构建：docker build -t dsh-relay .
# 运行：docker run -d -p 8787:8787 -e RELAY_TOKEN=$(openssl rand -hex 16) dsh-relay

FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8787

WORKDIR /app

# 先装依赖以利用层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

# 非 root 运行（node:alpine 自带 node 用户）
USER node

EXPOSE 8787

CMD ["node", "server.js"]
