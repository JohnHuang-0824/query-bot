# query-bot on Raspberry Pi 5 (arm64)
#
# 沒有 build 步驟，所以不需要多階段 —— 唯一的 runtime 依賴是 discord.js，
# 純 JS、沒有原生模組要編。
#
# 用 slim 而不是 alpine：省下的那幾十 MB 換不到什麼，而 glibc 少一類
# 「只在 musl 上壞掉」的驚喜。

FROM node:26-slim

# package.json 的 engines 要求 >= 26。基底映像已經滿足，這行只是讓
# 版本不符時在 build 階段就炸掉，而不是跑起來才出怪事。
RUN node -e "if (process.versions.node.split('.')[0] < 26) { console.error('need Node >= 26'); process.exit(1); }"

# lockfile 是 pnpm 的，用 corepack 裝對應版本，不要改用 npm ——
# 換套件管理器會產生不同的依賴樹，而那不是我們想在 Pi 上除錯的東西。
RUN corepack enable

WORKDIR /app

# 先只複製 manifest，讓依賴層在原始碼改動時還能命中快取。
# Pi 上每一次不必要的重裝都很有感。
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY . .

# db/ 放下載回來的 cards.cdb，是 volume 掛進來的（見 compose）。
# 這裡先建好並交給 node 使用者，否則容器內寫不進去。
RUN mkdir -p /app/db && chown -R node:node /app/db

# ⚠️ 不要用 root 跑。這個行程會對外連線並解析外部資料。
USER node

# 沒有 EXPOSE —— gateway 是由內往外開的 WebSocket，不需要任何 inbound port。
# 如果哪天看到有人加 EXPOSE，那代表架構被改成 HTTP Interactions 了，
# 那是另一個決定（見 架構決策.md 第五節）。

CMD ["node", "bot.js"]
