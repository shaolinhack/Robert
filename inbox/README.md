# inbox — Chrome 存檔的上傳區

把 Chrome 用「網頁，完整」存下來的檔案放進這個資料夾，然後執行：

```bash
npm run import   # inbox/ → snapshot/
npm run build    # snapshot/ + content/ → public/
```

每個頁面會有兩樣東西，**兩個都要放進來**：

```
inbox/
├── Robert.html          ← 網頁檔
├── Robert_files/        ← 同名資料夾，裡面是所有圖片與 CSS
├── 關於我.html
├── 關於我_files/
└── routes.json          ← 可選：指定每個檔案對應的網址
```

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
