# Labelme — 後端

FastAPI + PyMongo（async）+ redis.asyncio。所有 API 都在 `/api` 底下。整體啟動方式（含模擬模式）見上一層的 `README.md`。

## 安裝與執行

```bash
cd defect-labeler/backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"

cp .env.example .env          # 修改 Mongo / Redis 連線
.venv/bin/uvicorn app.main:app --reload --port 8001
# API 文件：http://localhost:8001/docs

# 模擬模式（不需要 Mongo / Redis）
DL_DEMO=1 DL_DEV_USER_ID=weichun .venv/bin/uvicorn app.main:app --port 8001
```

設定檔放在 `config/`：`source.yaml`（來源欄位對應）、`users.yaml`（權限）、`classes.yaml`（缺點類別）。修改後要重啟。

## 測試

```bash
.venv/bin/python -m pytest
```

測試使用 mongomock（包在 `app/dev/mock_mongo.py`，模擬 PyMongo async 介面）和 fakeredis，不需要真的資料庫。
mongomock 和真正的 Mongo 仍有差異（已知並繞過的：bulk_write 不相容、find_one_and_update 回傳更新後文件時會用原條件重查），
**第一次接上真正的 Mongo 時，請手動完整走一次所有頁面**。

## API

完整清單與欄位見 http://localhost:8001/docs 。

| API | 權限 | 說明 |
|---|---|---|
| `GET /api/classes` | `view` | 缺點類別（classes.yaml） |
| `GET /api/lots/{lot}/annotations` | `view` | Lot 圖片清單（`verdict`、`class_id`、`ai`、`ai_cmp` 篩選，cursor 分頁） |
| `GET /api/lots/{lot}/facets` | `view` | 各篩選選項的張數（彼此連動） |
| `POST /api/lots/{lot}/queue/next` | `annotate` | 下一張未標註且沒人鎖定的圖（已替你取得鎖） |
| `GET /api/annotations/{id}` | `view` | 標註頁資料 |
| `PUT /api/annotations/{id}` | `annotate` | 儲存；版本衝突 409、別人鎖定中 423、類別停用或框超出範圍 422 |
| `POST /api/annotations/{id}/lock` | `annotate` | 編輯鎖：acquire / renew / release / status |
| `GET /api/annotations/{id}/neighbors` | `view` | 上一張／下一張（`mode=lot` 篩選結果內、`mode=class` 跨 Lot 同類別） |
| `GET /api/stats` | `view` | 缺點分布統計（全部已開啟的 Lot，快取 60 秒，`refresh=true` 重算） |
| `GET /api/classes/{id}/images` | `view` | 類別圖片清單（跨全部 Lot） |

### 主頁

| API | 權限 | 說明 |
|---|---|---|
| `GET /api/me` | 已在 users.yaml 中且未停用 | 目前使用者的 id、name、role、permissions |
| `GET /api/lots/{lot}` | `view` | 查詢 Lot：圖片數量、meta（產品／站點）、狀態、進度、線上人數 |
| `POST /api/lots/{lot}/open` | `open_lot` | 開啟 Lot：開始背景初始化回 202，已開啟回 200 |

`GET /lots/{lot}` 的 `status`：

| status | 意思 | 主頁顯示 |
|---|---|---|
| `new` | 來源有這個 Lot，還沒開啟 | 「開啟 Lot」按鈕 |
| `initializing` | 開啟中，`init` 為 `{done, total}` | 進度條，每秒輪詢一次 `GET /lots/{lot}` |
| `open` | 已開啟，`progress` 為 `{total, done, ok, ng}` | 「看圖片清單」、「開始標註」 |
| `failed` | 開啟失敗或中斷，`error` 為原因 | 錯誤訊息＋「重新開啟」 |

`data_source`：`redis`（快取命中）、`mongo`（快取未命中，背景回填中）、`annotations`（已開啟，讀自標註資料）。

錯誤：Lot 格式不對回 422、找不到 Lot 回 404、沒有身分或已停用回 401、權限不足回 403。`detail` 是中文訊息，可以直接顯示。

## 身分

外部身分如何傳進來尚未確定，目前從 HTTP header `X-User-Id` 讀取（`DL_IDENTITY_HEADER` 可改）。
開發時可以設定 `DL_DEV_USER_ID=weichun`，沒有 header 時就當作這個使用者，**正式環境要拿掉**。
