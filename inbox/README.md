# inbox — Chrome 存檔的上傳區

把 Chrome 用「網頁，完整」存下來的檔案放進這個資料夾，然後執行：

```bash
npm run import   # inbox/ → snapshot/
npm run build    # snapshot/ + content/ → public/
```

## 怎麼放

每個頁面會有**兩樣東西，都要放進來**：`頁面.html` 和同名的 `頁面_files/` 資料夾。

**資料夾層數不拘**，匯入時會遞迴尋找所有 HTML。所以直接把 ZIP 解壓進來就行，
多包一層也沒關係：

```
inbox/
├── 網站備份/              ← 解壓後多出來的一層，沒問題
│   ├── Robert.html
│   ├── Robert_files/
│   ├── 關於我.html
│   └── 關於我_files/
└── routes.json
```

唯一的要求是：**`_files` 資料夾必須和它的 `.html` 在同一層**。這是 Chrome 存檔
的原始結構，不要去搬動它。

## routes.json

檔名是中文時無法自動轉成網址，需要用這個檔案指定：

```json
{
  "Robert.html": "/",
  "關於我.html": "/about",
  "作品集.html": "/works"
}
```

首頁請對應到 `/`。只上傳一個頁面時會自動視為首頁，不需要這個檔案。

## 匯入時會自動處理

- 把 `Robert_files/` 裡的資源搬到 `/assets/home/`，並改寫 HTML 與 CSS 內的路徑
- 移除所有 `<script>`（保留 JSON-LD 結構化資料）與追蹤像素
- 排除 `.js` 檔案 —— 腳本已移除，Wix 的 bundle 只是死重量
- 把頁面之間的連結（`關於我.html`）改成網站路由（`/about`）

## 會擋下來的狀況

- **HTML 引用了 `_files` 資料夾但找不到** → 印出警告，指出圖片會全部破掉
- **兩個頁面對應到同一個網址** → 直接報錯，不會安靜地覆蓋掉其中一頁
