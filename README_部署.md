# 部署（fork 專用）

這份文件只存在於 fork，**不會進上游的 PR**。上游沒有也不需要我們的
部署方式。

架構上的「為什麼」在同層的 `../YGORuleData/架構決策.md`，這裡只講怎麼跑起來。
兩個 repo 是獨立的：那邊放決策紀錄與資料資產，這邊放程式碼。

---

## 一、先在自己的機器上跑

### 1. Discord Developer Portal

建立 Application，然後：

| 位置 | 做什麼 |
|---|---|
| Bot → Token | Reset 一次，複製下來填進 `.env` 的 `TOKEN` |
| Bot → **Public Bot** | ⚠️ **關掉。** 只有你能把它加進伺服器 |
| Bot → Privileged Gateway Intents | ⚠️ **一個都不要開**，見下 |
| General Information → Application ID | 填 `CLIENT_ID` |

⚠️ **不要申請 Message Content Intent。** 那是要送審的特權 intent，而
全部走 slash command 就天生不需要它。這是該守住的設計約束 —— 不要為了
「順便支援直接聊天」去開它。

邀請連結的 scopes 只要 `bot` + `applications.commands`。

### 2. 環境變數

```bash
cp .env.example .env
```

四個都要填。`GUILD_ID` 是**你自己的私人測試伺服器**。

### 3. 跑起來

```bash
corepack enable
pnpm install
node bot.js
```

第一次啟動會自己去上游的 Release 下載 `cards.cdb`，放進 `db/`。
那個目錄在 `.gitignore` 裡，不會進版控。

---

## 一之二、容器開發（本機不裝 Node）

`package.json` 要求 Node >= 26，而 `node:sqlite` 要 22.5 以上才有。與其在
開發機折騰版本，不如讓容器決定 —— 反正部署本來就走容器，兩邊用同一個
基底映像也少一類「我這邊好好的」。

```
docker compose -f docker-compose.dev.yml up --build     # 第一次
docker compose -f docker-compose.dev.yml up             # 之後
```

原始碼是 bind mount 進去的，改完**重啟容器**就生效，不用重新 build。
改了 `package.json` 才需要 `--build -V`（`-V` 是為了丟掉裝著舊依賴的
匿名 volume）。

### 開發迴圈

| 改了什麼 | 要做什麼 |
|---|---|
| 指令的**處理邏輯** | 重啟容器 |
| 指令的**定義**（名稱／描述／選項） | 重啟容器，再私訊 bot `deploy!` |
| `package.json` | `up --build -V` |

bot 的管理指令走**私訊**，而且只認 `.env` 裡的 `ADMIN`：

| 私訊 | 作用 |
|---|---|
| `deploy!` | 重新註冊 slash command |
| `r!` | 關掉 bot |

### ⚠️ 不要用 nodemon 或 --watch

這是這個專案跟一般 Node 開發最不一樣的地方。

**每次重啟 = 一次 Discord identify，而 identify 有每日上限。** 存檔就重啟
的習慣在別的專案是效率，在 Discord bot 上是把配額燒光 —— 而撞到上限的
症狀是 bot 連不上，看起來像 token 壞了，你會往完全錯誤的方向查。

手動重啟就好。一天幾十次沒問題，自動存檔觸發就不是。

---

## 二、在 Pi 上跑

`.env` 除了上面四個，還要加一行：

```
SSD_MOUNT=/mnt/ssd
```

理由跟 RestForFoodie 一樣：**PostgreSQL 的 WAL 對 microSD 是致命的寫入
放大**。我們這裡雖然只有一個 SQLite 檔、寫入量小得多，但既然 SSD 已經
掛著，沒有理由讓 `cards.cdb` 留在 SD 卡上。

```bash
docker compose --env-file .env -f docker-compose.pi.yml up -d --build
docker compose -f docker-compose.pi.yml logs -f
```

⚠️ **不要寫「每次 deploy 都 restart」的腳本。** gateway 重啟要重新
identify，而 Discord 對 identify 有每日上限。只在程式碼真的變了的時候
才重建。

---

## 三、⚠️ 拿到 salix5 回覆之前的界線

`salix5/cdb#1` 還在等回覆。**界線不是「不能碰資料」，是「不能對外提供
服務」** —— 跑一個未修改的 fork，就是任何 query-bot 使用者都在做的事。

| 可以 | 不可以 |
|---|---|
| 本機跑、Pi 上跑 | 把 bot 邀請到別人的伺服器 |
| 自己的私人測試伺服器 | 分享邀請連結 |
| 下載 `cards.cdb`、開發 `/ruling` | 在哪裡宣傳或列出它 |
| 開發裁定抓取器（那是 Konami 的資料，已查證） | Public Bot 開著 |

### `experimental` 是上游內建的隔離機制

`deploy-commands.js` 的規則是：

| 指令標記 | 註冊到哪 |
|---|---|
| （無） | **全域** —— 所有加了這個 bot 的伺服器 |
| `experimental: true` | **只有 `GUILD_ID`** 那一個伺服器 |

所以 `commands/ruling.js` 在開發期間一律掛 `experimental: true`。
它從結構上就不會外流，而之後要公開只是拿掉一行。

---

## 四、加新指令不需要改任何既有檔案

`bot.js` 用 `readdirSync` 掃 `commands/` 下的每個 `.js` 並動態 import。
所以：

```
commands/ruling.js     ← 新增
ygo-ruling.mjs         ← 新增
（裁定與別名的 SQLite 檔，獨立於 cards.cdb）
```

**零個既有檔案被修改。** 這正是 `../YGORuleData/架構決策.md` 第六節那四條 fork 規矩
想要的結果 —— diff 保持純新增，之後要向上游提 PR 時拿得出能 review
的東西。

⚠️ **但部署設定是例外**：`Dockerfile`、`docker-compose.pi.yml`、這份
文件都是我們自己的，**永遠不會進上游的 PR**。所以把它們跟 `/ruling`
的功能開發**分成不同的 commit**，之後挑 commit 就很輕鬆。

---

## 四之二、⚠️ 別名表要定期匯出

`db/ruling.db` 在 `.gitignore` 裡（裡面有快取的官方裁定，不能進版控），
而且只存在於那台機器的 SSD 上。**碟掛了，社群累積的俗稱就全沒了。**

別名表是架構決策第一節說的「唯一會隨時間增值的資產」，所以要定期撈回
可進版控的格式：

```bash
docker compose -f docker-compose.pi.yml exec -T bot node scripts/export-aliases.mjs > alias-seed.json
git add alias-seed.json && git commit -m "更新別名表"
```

⚠️ 只匯出俗稱，**不匯出快取的裁定** —— 那是別人的內容，我們承諾過不
轉散布。

核准幾筆新俗稱之後就跑一次。這是唯一會後悔沒做的維運工作。

---

## 五、跟上游同步

```bash
git fetch upstream
git merge upstream/master      # 上游的預設分支是 master，不是 main
```

⚠️ 他更新很勤（`cdb` 與 `query-bot` 都是幾天一次）。**放生幾個月就會
變成無法合併的分岔，那等於自己把提 PR 那條路關掉。**
