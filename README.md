# 股匠短線儀表板

## 🔔 人工確認紀錄（排程保活）

GitHub 規定：公開 repository 連續 60 天沒有活動，自動排程會被停用。
機器人的自動提交與手動 Run workflow 都不保證算數，
所以**每 6 週左右**請在這裡加一列並 Commit。

資料日照網頁標題下方三行填寫（例如「每日籌碼：資料日 **10/19**」就填 10/19）。

| 日期 | 每日籌碼資料日 | 技術訊號資料日 | 集保大戶資料日 | 狀態 | 備註 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-20 | __/__ | __/__ | __/__ | ✅ 正常 | 建立保活機制 |

**加一列的步驟**：
1. 打開 README.md，按右上角鉛筆圖示 ✏️
2. 在表格最後一列下面，照格式加一行（今天日期＋網頁上看到的三個資料日＋狀態）
3. 按右上角綠色「Commit changes」→ 再按一次確認

**怎麼判斷正常**：平日看網頁時，每日籌碼與技術訊號的資料日應該是最近一個交易日（技術訊號 18:07 後更新、籌碼 23:07 後更新），集保大戶應該是上週五（或連假前最後一個交易日）。落後很多天就到 Actions 看有沒有紅叉。

**請避開排程時段 Commit**：台北週一～五 18:00～18:20、23:00～23:20，週六 08:00～08:20、14:00～14:20，週日 10:00～10:20。（撞到也沒關係，機器人會自動 rebase 重試，只是避開比較保險。）

**萬一還是被停用了**：GitHub 會寄信通知。到 Actions → 選那個排程
workflow → 按「Enable workflow」即可恢復，資料不會遺失。

---

個人用的籌碼篩選網頁，GitHub Pages 靜態網站加 GitHub Actions 排程，沒有伺服器。

- **每日**：上市櫃普通股的外資連買天數、投信連買天數，外資持股比率為參考欄位（證交所 T86、MI_QFIIS；櫃買中心三大法人買賣明細）
- **技術訊號**：上市櫃普通股的帶量突破、多頭回測、盤整突破（證交所 MI_INDEX；櫃買中心上櫃股票每日收盤行情），並附上籌碼連買天數
- **每週**：上市櫃普通股的 400 張以上、1000 張以上大戶人數連升週數（集保股權分散表）

## 檔案

```
index.html                       網頁
scripts/daily.mjs                每日抓取與計算
scripts/weekly.mjs               每週抓取與計算
scripts/tech.mjs                 技術訊號抓取與計算
.github/workflows/daily.yml      台北週一～五 23:07
.github/workflows/tech.yml       台北週一～五 18:07
.github/workflows/weekly.yml     台北週六 08:07、14:07，週日 10:07（後兩班是補抓）
data/                            由 workflow 自動產生，勿手動編輯
```

## 建置步驟（GitHub 網頁介面）

1. 建立新的 **public** repo（與其他網站分開）
2. 上傳 `index.html`、`README.md`
3. 上傳兩支腳本：Add file → Create new file，檔名輸入 `scripts/daily.mjs`（打斜線會自動建資料夾），貼上內容 → Commit。`weekly.mjs` 同理
4. 兩個 workflow 同樣用 Create new file，檔名輸入 `.github/workflows/daily.yml`、`.github/workflows/tech.yml       台北週一～五 18:07
.github/workflows/weekly.yml`
5. Settings → Actions → General → Workflow permissions 改成 **Read and write permissions**
6. Settings → Pages → Source 選 Deploy from a branch，branch 選 `main`、資料夾 `/ (root)`
7. Actions 分頁 → 分別對「每日更新」「每週更新」按 **Run workflow** 各跑一次

第一次的每日更新會往回補約 30 個交易日，約 70 個請求、需 4～5 分鐘。之後每天通常只有 2 個請求。

## 重要限制

- **集保開放資料只有最新一週**，歷史從第一次執行開始累積。連升 2 週需要 3 週資料，連升 5 週需要 6 週資料
- 每日籌碼的外資持股比率只有上市；技術訊號的除息提醒只有上市
- 網頁讀的是 `raw.githubusercontent.com` 的資料（GitHub Pages 不會因為機器人的 commit 重建），剛更新完可能有約 5 分鐘快取

## 維護

- **漏跑沒關係**：每日更新每次會往回檢查 10 天，缺的交易日自動補抓。休市日記在 `data/daily/closed.json`
- 日誌出現「回應 403／307」或大量逾時 → 被擋了，把 `daily.mjs` 的 `REQUEST_GAP_MS` 從 3000 調高
- 日誌出現「欄位對不上」→ 證交所改了欄位名稱，日誌會列出新的欄位
- 技術訊號的門檻集中在 `tech.mjs` 開頭的 `P` 設定（量比、乖離、均量等），要調整只改那裡
- 技術訊號連續 3 個日期抓取失敗會自動停止該次執行（斷路器），下次排程接著補
- 日誌出現「這一週已經存過了」→ 正常，集保還沒更新或已經抓過
- repo 連續 60 天沒有人為活動，排程會被停用（機器人的 commit 不算），收到通知信點 Enable 即可
- **要確認線上狀態，看 Actions 日誌，不要用抓取工具抓網址**（會拿到快取的舊資料）
