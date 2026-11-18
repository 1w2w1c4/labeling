# Labelme（AVI 缺點偵測框圖標註）

缺點偵測框圖標註系統。後端 FastAPI（`backend/`），前端 React + TypeScript + Vite（`frontend/`）。

## 模擬模式（不需要 Mongo、Redis）

資料都在記憶體裡，啟動時自動產生假的 Lot、標註和 300×300 假圖片，重啟後重新產生。

```bash
# 1. 後端（第一次要先安裝）
cd defect-labeler/backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
DL_DEMO=1 DL_DEV_USER_ID=weichun .venv/bin/uvicorn app.main:app --port 8001

# 2a. 只想直接使用：編譯前端，後端會一起提供 → 開 http://127.0.0.1:8001
cd defect-labeler/frontend
npm install
npm run build

# 2b. 要改前端：開發伺服器（改程式自動更新）→ 開 http://localhost:5173
npm run dev
```

模擬資料：

| Lot | 狀態 |
|---|---|
| `202611-01-03` | 已開啟，3,000 張，約六成已標註，幾張圖「別人正在編輯」 |
| `202611-01-04` | 已開啟，800 張，全部標註完成 |
| `202611-02-01` | 尚未開啟，1,200 張（可以測試「開啟 Lot」） |

換使用者測試權限：把 `DL_DEV_USER_ID` 改成 `eric`（viewer，只能看）或 `amy`（editor），重啟後端。
用兩個不同的使用者同時開同一張圖，可以測試編輯鎖（例如另一個瀏覽器用前端開發伺服器並設定 `VITE_DEV_USER_ID=amy`）。

## 連接真正的 Mongo / Redis

```bash
cd defect-labeler/backend
cp .env.example .env    # 修改 DL_MONGO_URI、DL_MONGO_DB、DL_REDIS_URL；拿掉 DL_DEMO
.venv/bin/uvicorn app.main:app --port 8001
```

- 來源欄位對應改 `backend/config/source.yaml`（目前是佔位值，拿到 Mongo 樣本文件後修改）。
- 圖片路徑轉 URL 改 `source.yaml` 的 `url_rules`。
- 身分目前從 HTTP header `X-User-Id` 讀取；正式環境要由反向代理帶入，並拿掉 `DL_DEV_USER_ID`。

## 測試

```bash
cd defect-labeler/backend && .venv/bin/python -m pytest      # 後端 41 個測試（mongomock + fakeredis）
cd defect-labeler/frontend && npm run typecheck              # 前端型別檢查
```

## 部署建議

前端 `npm run build` 後的 `frontend/dist` 可以直接由後端提供（同一個網域，沒有 CORS 問題），
或放到 nginx：`/` 給前端靜態檔（找不到的路徑回 `index.html`）、`/api` 轉給後端、圖片照原本的 nginx 規則。
