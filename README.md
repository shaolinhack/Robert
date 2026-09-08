# Robert 個人網站 — 從 Wix 遷移到 Zeabur

把 <https://shaolinhack.wixsite.com/robert> 遷離 Wix，改以 Docker + Caddy 部署在 Zeabur。

採**兩階段**策略：

1. **先快照上線** — 把 Wix 網站原樣抓成靜態檔，立刻能脫離 Wix，網站不斷線
2. **再逐步重寫** — 一頁一頁換成乾淨、好維護的版本，沒重寫的頁面繼續用快照

建置系統支援兩者共存，所以第二階段可以慢慢做，網站隨時保持完整可用。

---

## 目前狀態

| 項目 | 狀態 |
| --- | --- |
| 部署管線（Docker + Caddy + Zeabur） | ✅ 完成並驗證 |
| 抓站工具 `npm run capture` | ✅ 完成 |
| 建置系統 `npm run build` | ✅ 完成並驗證 |
| 驗收工具 `npm run audit` | ✅ 完成 |
| 重寫版設計系統與區塊 | ✅ 完成（待依原站調整視覺） |
| **階段一：Wix 快照** | ⬜ 待執行 `npm run capture` |
| **階段二：頁面重寫** | ⬜ 待提供素材 |

### 為什麼快照還沒抓

產生這個專案的環境，對外網路受組織政策限制，`shaolinhack.wixsite.com` 與
`static.wixstatic.com` 都被出口代理擋下（403）。抓站需要在**一台有正常對外網路
的電腦**上執行一次，工具已經寫好。

---

## 階段一：抓快照並上線

有兩條路，擇一即可。

### 路線 A — 不用終端機（Chrome 存檔 + GitHub 網頁上傳）

適合不熟指令的情況，不需要安裝任何東西。

1. 用 Chrome 打開網站的每一頁，**先捲到最底**（觸發圖片載入），再按 `Ctrl+S`
2. 存檔類型選 **「網頁，完整」**，會得到 `頁面.html` 加一個 `頁面_files/` 資料夾
3. 到 GitHub 這個 repo 的 `inbox/` 資料夾，用 **Add file → Upload files** 把
   HTML 與 `_files` 資料夾一起拖進去（詳見 [`inbox/README.md`](inbox/README.md)）
4. 中文檔名需要一併上傳 `inbox/routes.json` 指定每頁的網址

上傳後由維護者執行 `npm run import` 轉成 `snapshot/`，再 `npm run build`。

### 路線 B — 用終端機自動抓（結果較完整）

需求：Node.js 20 以上。

```bash
git clone -b claude/wix-to-zeabur-migration-yy0vdt https://github.com/shaolinhack/Robert.git
cd Robert

npm install
npx playwright install chromium   # 無頭瀏覽器，約 150MB，只需一次

npm run capture   # 抓取 Wix 網站 → snapshot/
npm run build     # snapshot/ + content/ → public/
npm run audit     # 驗收：確認沒有殘留的 Wix 依賴
npm run preview   # 本機預覽 http://localhost:4173
```

確認畫面沒問題後推上去，Zeabur 會自動重新部署：

```bash
git add snapshot
git commit -m "chore: 匯入 Wix 網站靜態快照"
git push -u origin claude/wix-to-zeabur-migration-yy0vdt
```

### `npm run capture` 做了什麼

用真實的 Chromium 逐頁載入網站，等 JavaScript 跑完、捲到頁尾觸發 lazy-load，
才存下**渲染後的 DOM**。過程中攔截所有圖片、字型、CSS 回應存到 `snapshot/assets/`，
最後把 HTML 與 CSS 裡指向 Wix 的網址全部改寫成本地路徑，並移除 Wix 的執行期
JavaScript 與追蹤程式（保留 JSON-LD 結構化資料以維持 SEO）。

從首頁開始廣度優先爬取站內連結，輸出成乾淨網址結構：

| 原始網址 | 輸出檔案 | 上線後路徑 |
| --- | --- | --- |
| `/robert` | `snapshot/index.html` | `/` |
| `/robert/about` | `snapshot/about/index.html` | `/about` |

可調參數（環境變數）：`START_URL`、`OUT_DIR`、`MAX_PAGES`、`KEEP_SCRIPTS=1`（保留原始 JS，除錯用）。

### 快照的限制

移除所有 JavaScript 之後，**依賴 JS 的互動功能不會保留**：手機版選單、輪播、
燈箱、聯絡表單送出、線上訂位、會員登入等 Wix App。

`npm run preview` 逐頁點過一次，把壞掉的功能記下來——這些正好是第二階段要優先
重寫的頁面。

---

## 階段二：逐頁重寫成乾淨版

在 `content/pages/` 放一個 JSON，該頁就會換成重寫版，蓋掉同路徑的快照：

```
content/pages/index.json    →  /          （覆蓋 snapshot/index.html）
content/pages/about.json    →  /about     （覆蓋 snapshot/about/index.html）
```

沒有對應 JSON 的頁面繼續走快照。`npm run build` 會印出哪些頁面是快照、哪些是重寫版。

### 頁面格式

頁面由**區塊**組成，每種區塊對應一段語意化 HTML。完整寫法見
[`content/pages/_example.json`](content/pages/_example.json)（底線開頭的檔案不會被建置）。

可用區塊：

| 區塊 | 用途 |
| --- | --- |
| `hero` | 首屏主視覺：小標、大標、副標、圖片、按鈕 |
| `prose` | 純文字段落，可置中、可加淺色底 |
| `split` | 圖文並排，圖片可放左或右 |
| `cards` | 卡片列表：服務項目、作品集、文章 |
| `gallery` | 圖庫，含圖說 |
| `contact` | 聯絡資訊（Email / 電話 / 地址） |
| `cta` | 行動呼籲 |

文字欄位支援極簡行內 Markdown：`**粗體**`、`*斜體*`、`[文字](網址)`、`` `程式碼` ``。
所有內容都會先做 HTML 轉義，不可能注入標籤。

全站設定（站名、導覽、頁尾、社群連結、SEO）在 [`content/site.json`](content/site.json)。
自己的圖片放 `content/assets/`，會被複製到 `/assets/`。

### 視覺調整

所有顏色、字體、間距、圓角都是 `src/styles.css` 開頭 `:root` 的 CSS 變數。
拿到原站的配色與字體後，主要只需要調那一段。已內建淺色／深色模式、響應式排版、
純 CSS 手機選單（不需要 JavaScript）。

### 需要你提供的素材

每一頁請給：

1. **文字內容** — 標題、段落、按鈕文字（直接貼給我就行）
2. **圖片** — 原始檔最好；沒有的話快照抓下來的 `snapshot/assets/` 裡就有
3. **截圖** — 桌機版全頁截圖，讓我知道原本的版面與配色
4. **導覽結構** — 有哪些頁、選單順序
5. **聯絡方式** — Email／電話／地址／社群連結，以及表單原本會送到哪裡

先給首頁就可以開始，其餘頁面陸續補。

---

## 部署到 Zeabur

專案根目錄有 `Dockerfile`，Zeabur 會自動偵測並以 Docker 建置，不需要額外設定。

1. 到 [Zeabur Dashboard](https://dash.zeabur.com) → **Create Project**，區域建議選離使用者近的（如 Hong Kong / Tokyo）
2. **Add Service** → **Git** → 授權 GitHub 並選擇 `shaolinhack/Robert`
3. 分支選 `claude/wix-to-zeabur-migration-yy0vdt`（合併到 `main` 後改選 `main`）
4. Zeabur 偵測到 `Dockerfile` 後直接建置，不需要填建置指令或輸出目錄
5. 建置完成後進入服務的 **Networking** → **Generate Domain**，取得 `xxx.zeabur.app` 網址

之後每次 push 到該分支，Zeabur 都會自動重新建置部署。

`public/` 是建置產物，不進版控——Zeabur 會在 Docker 裡跑 `npm run build` 產生。
進版控的是來源：`snapshot/`、`content/`、`src/`。

### 綁定自訂網域

在 **Networking** → **Add Domain** 填入網域，Zeabur 會給一組 DNS 記錄：

- 根網域（`example.com`）→ 依指示設定 `A` 或 `ALIAS`/`ANAME`
- 子網域（`www.example.com`）→ 設定 `CNAME` 指向 Zeabur 給的目標

DNS 生效後 Zeabur 自動簽發並續期 Let's Encrypt 憑證。
記得回填 `content/site.json` 的 `baseUrl`，canonical 與 sitemap 才會正確。

### 如果網域目前綁在 Wix

先確認 Zeabur 上的網站完全正確，**再**改 DNS：

1. 先把 DNS 的 TTL 調低（例如 300 秒），等舊 TTL 過期
2. 在 Zeabur 加好自訂網域
3. DNS 記錄從 Wix 改指向 Zeabur
4. 確認新站正常、HTTPS 憑證已簽發後，才取消 Wix 訂閱

反過來先退訂 Wix，網站會在 DNS 生效前先斷線。

---

## 專案結構

```
.
├── Dockerfile          # 多階段：node 跑 build → caddy 服務產出
├── Caddyfile           # 乾淨網址、壓縮、快取策略、安全標頭、404
├── content/            # 階段二：重寫版內容（進版控）
│   ├── site.json       #   全站設定
│   ├── assets/         #   自備圖片 → /assets/
│   └── pages/
│       └── _example.json  # 區塊語法範例，不會被建置
├── inbox/              # Chrome 存檔的上傳區（給路線 A 用）
├── snapshot/           # 階段一：Wix 快照（進版控，capture 或 import 產生）
├── src/
│   ├── styles.css      # 設計系統，視覺全由 :root 變數控制
│   └── render.mjs      # 區塊 → 語意化 HTML（零相依）
├── scripts/
│   ├── capture.mjs     # 抓 Wix 站 → snapshot/（路線 B）
│   ├── import-chrome-save.mjs  # inbox/ → snapshot/（路線 A）
│   ├── build.mjs       # snapshot/ + content/ → public/
│   ├── audit.mjs       # 掃描殘留的 Wix / 追蹤依賴
│   └── serve.mjs       # 零相依本機預覽，行為對齊正式環境
└── public/             # 建置產物，已 gitignore
```

### 建置流程

```
snapshot/  ──┐
content/   ──┼──►  build.mjs  ──►  public/  ──►  Caddy
src/       ──┘
```

`build.mjs` 先把 `snapshot/` 整個複製到 `public/` 打底，再用 `content/pages/` 的
重寫版覆蓋同路徑頁面，最後產生 `404.html`、`sitemap.xml`（涵蓋快照頁與重寫頁）、
`robots.txt`。零相依，Docker 建置階段不需要 `npm install`。

### Caddy 設定重點

- `try_files {path} {path}/index.html {path}.html` — 支援 `/about` 這類乾淨網址
- `/assets/*` 給一年 immutable 快取；其餘走 `must-revalidate`
- `handle_errors` 把 404 導到 `404.html`，並保留 404 狀態碼
- 監聽 `{$PORT:8080}`，直接吃 Zeabur 注入的 `PORT`

---

## 驗收

`npm run audit` 掃描 `public/`，發現以下服務的網址就以 exit code 1 結束（可接 CI）：

- `static.wixstatic.com` / `static.parastorage.com` — Wix 的 CDN
- `*.wixsite.com` / `wixapps.net` / `wix.com`
- Google Analytics、Google Tag Manager、Sentry、Facebook Pixel

全部清乾淨才算真正脫離 Wix；否則使用者瀏覽時仍會連回 Wix 伺服器。

已驗證項目：Caddyfile 通過 `caddy validate`；乾淨網址、404 狀態碼、快取標頭、
安全標頭皆實測正確；重寫版在桌機／手機／深色模式下排版正常，純 CSS 選單可開合，
無橫向溢出，無 JavaScript 錯誤。
