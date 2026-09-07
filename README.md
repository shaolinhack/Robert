# Robert 個人網站 — 從 Wix 遷移到 Zeabur

把 <https://shaolinhack.wixsite.com/robert> 完整複製成一份**不依賴 Wix** 的靜態網站，
以 Docker + Caddy 部署在 Zeabur 上。

部署管線、抓站工具、驗收工具都已就緒並驗證過。**唯一還缺的是網站內容本身** —
原因與補齊方式見下一節。

---

## 為什麼 `public/` 目前只有佔位頁

產生這個專案的環境，對外網路受組織政策限制，`shaolinhack.wixsite.com` 與
`static.wixstatic.com` 的連線都被出口代理擋下（回應 403）。因此無法在該環境內
直接抓取網站內容。

抓站的部分需要你在**一台有正常對外網路的電腦**上執行一次，工具已經寫好了。

---

## 快速開始：把 Wix 網站抓下來

需求：Node.js 20 以上。

```bash
git clone -b claude/wix-to-zeabur-migration-yy0vdt https://github.com/shaolinhack/Robert.git
cd Robert

npm install
npx playwright install chromium   # 下載無頭瀏覽器（約 150MB，只需一次）

npm run capture                   # 抓取並改寫整站 → public/
npm run audit                     # 驗收：確認沒有殘留的 Wix 依賴
npm run preview                   # 本機預覽 http://localhost:4173
```

確認畫面沒問題後：

```bash
git add public
git commit -m "chore: 匯入 Wix 網站靜態快照"
git push -u origin claude/wix-to-zeabur-migration-yy0vdt
```

### `npm run capture` 做了什麼

用真實的 Chromium 逐頁載入網站，等 JavaScript 跑完、捲到頁尾觸發 lazy-load，
才存下**渲染後的 DOM**。過程中攔截所有圖片、字型、CSS 回應存到 `public/assets/`，
最後把 HTML 與 CSS 裡指向 Wix 的網址全部改寫成本地路徑，並移除 Wix 的執行期
JavaScript 與追蹤程式（保留 JSON-LD 結構化資料以維持 SEO）。

從首頁開始廣度優先爬取站內連結，頁面輸出成乾淨網址結構：

| 原始網址 | 輸出檔案 | 上線後路徑 |
| --- | --- | --- |
| `/robert` | `public/index.html` | `/` |
| `/robert/about` | `public/about/index.html` | `/about` |

可調參數（環境變數）：

```bash
START_URL=https://shaolinhack.wixsite.com/robert   # 起始網址
OUT_DIR=public                                     # 輸出目錄
MAX_PAGES=100                                      # 頁數上限
KEEP_SCRIPTS=1                                     # 保留原始 JS（除錯用）
```

### 抓完之後請人工檢查

靜態快照會移除所有 JavaScript，所以**依賴 JS 的互動功能不會保留**，例如：

- 手機版的漢堡選單
- 輪播 / 相簿燈箱
- 聯絡表單送出（Wix 表單會送到 Wix 後端，脫離 Wix 後必然失效）
- 線上訂位、購物車、會員登入等 Wix App

`npm run preview` 逐頁點過一次，把壞掉的功能列出來。這些需要用原生 JavaScript
重寫，或改接第三方服務（例如表單改用 Formspree / Web3Forms）。

---

## 部署到 Zeabur

專案根目錄有 `Dockerfile`，Zeabur 會自動偵測並以 Docker 建置，不需要額外設定。

1. 到 [Zeabur Dashboard](https://dash.zeabur.com) → **Create Project**，區域建議選離使用者近的（如 Hong Kong / Tokyo）
2. **Add Service** → **Git** → 授權 GitHub 並選擇 `shaolinhack/Robert`
3. 分支選 `claude/wix-to-zeabur-migration-yy0vdt`（合併到 `main` 後改選 `main`）
4. Zeabur 偵測到 `Dockerfile` 後直接建置，不需要填建置指令或輸出目錄
5. 建置完成後進入服務的 **Networking** → **Generate Domain**，取得 `xxx.zeabur.app` 網址

之後每次 push 到該分支，Zeabur 都會自動重新建置部署。

### 綁定自訂網域

在 **Networking** → **Add Domain** 填入你的網域，Zeabur 會給一組 DNS 記錄：

- 根網域（`example.com`）→ 依 Zeabur 指示設定 `A` 或 `ALIAS`/`ANAME` 記錄
- 子網域（`www.example.com`）→ 設定 `CNAME` 指向 Zeabur 提供的目標

DNS 生效後 Zeabur 會自動簽發並續期 Let's Encrypt 憑證。

### 如果網域目前綁在 Wix

先確認 Zeabur 上的網站內容完全正確、可以正常瀏覽，**再**去改 DNS。切換順序：

1. 先把 DNS 的 TTL 調低（例如 300 秒），等舊 TTL 過期
2. 在 Zeabur 加好自訂網域
3. 把 DNS 記錄從 Wix 改指向 Zeabur
4. 確認新站正常、HTTPS 憑證已簽發後，再取消 Wix 訂閱

反過來先退訂 Wix 的話，網站會在 DNS 生效前先斷線。

---

## 專案結構

```
.
├── Dockerfile          # Caddy 靜態伺服器映像；建置時會驗證 Caddyfile
├── Caddyfile           # 乾淨網址、gzip/zstd 壓縮、快取策略、安全標頭、404
├── package.json
├── public/             # 網站本體（部署的就是這個目錄）
│   ├── index.html      # 目前是佔位頁，capture 後會被覆蓋
│   └── 404.html
└── scripts/
    ├── capture.mjs     # 抓取 Wix 網站並改寫成本地資源
    ├── audit.mjs       # 掃描殘留的 Wix / 追蹤服務依賴
    └── serve.mjs       # 零相依本機預覽，行為對齊正式環境
```

### Caddy 設定重點

- `try_files {path} {path}/index.html {path}.html` — 支援 `/about` 這類乾淨網址
- `/assets/*` 給一年的 immutable 快取；HTML 與乾淨網址走 `must-revalidate`
- `handle_errors` 把 404 導到 `public/404.html`，並保留 404 狀態碼
- 監聽 `{$PORT:8080}`，直接吃 Zeabur 注入的 `PORT` 環境變數

---

## 驗收

`npm run audit` 會掃描 `public/` 內是否還有指向以下服務的網址，有殘留就以
exit code 1 結束（方便接 CI）：

- `static.wixstatic.com` / `static.parastorage.com` — Wix 的 CDN
- `*.wixsite.com` / `wixapps.net` / `wix.com`
- Google Analytics、Google Tag Manager、Sentry、Facebook Pixel

全部清乾淨才算真正脫離 Wix；否則使用者瀏覽時仍會連回 Wix 伺服器。

---

## 已知取捨

**這是靜態快照，不是原專案的重建。** 它忠實保留視覺與內容，但 HTML 是 Wix
產生器輸出的結果 — 巢狀很深、class 名稱是亂碼，日後手動改內容會不好維護。

如果之後想長期經營這個網站，建議在快照確認無誤後，以它為設計參考重寫成乾淨的
HTML/CSS（或 Astro 之類的靜態框架）。快照的價值在於：先安全脫離 Wix，內容和
設計都留在自己手上，重寫可以慢慢來。
