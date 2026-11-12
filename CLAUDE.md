# 缺點偵測標註系統（Defect Labeler）

類似 labelme 的網頁標註工具，前後端都要做，用途是**缺點偵測**，標註結果匯出給 **YOLO** 訓練。

> 狀態：設計討論已完成，正在做可點擊的 HTML 原型（`labelImg/prototype/`），尚未開始寫正式程式。
> 專案位置：`/Users/weichun/Desktop/Program/labelimg/defect-labeler/`

## 回覆語言
與使用者溝通時使用**繁體中文**。

---

## 1. 需求摘要

- 資料來源是**既有的 MongoDB**，前面有**既有的 Redis** 作為快取：先讀 Redis，找不到才查 Mongo（cache-aside）。
- Redis 的 key 是 **Lot**。我們可以寫入 Redis，也可以建立自己的 key。
- **圖片檔由 nginx 提供**。Mongo/Redis 只存圖片基本資料（含路徑），路徑轉 URL 有轉換規則。
- **只做 bounding box**。
- 標註結果存到**另一個 collection**。
- **多人協作**：多人分工標同一個 Lot。
- 以 **Lot** 為工作單位，一個 Lot 可能有**上萬張圖**。入口要能輸入 Lot。
- **Lot 格式固定為 `xxxxxx-xx-xx`**（目前假設 x 為英數字，regex `^[A-Z0-9]{6}-[A-Z0-9]{2}-[A-Z0-9]{2}$`）。前端輸入時自動轉大寫並補 `-`，格式不對不能送出；後端 API 也要驗證。
- 來源資料帶有 **AI 分類結果**（每張圖一個：`OK` 或某個缺點類別，加信心分數）。要能依 AI 結果篩選，並和人工判定比對出 **逃漏 / 過殺**。
- 每筆標註存：**圖片基本資訊、缺點位置、缺點名稱**。一張圖可以有**多個缺點**。
- schema **保留欄位彈性**。
- 需要能**檢查並修正先前的框圖結果**。
- 修正前要有**缺點分布統計頁**，從各個缺點點進去，直接看到框過該缺點的圖。
- **不做標註人員的統計**（不統計每個人標了多少張，也不提供依標註人員篩選）。

## 2. 技術選型

- 後端：FastAPI + Motor（async Mongo）+ redis.asyncio + Pydantic
  - 核心欄位嚴格驗證；`meta` / `extra` / `attributes` 使用 `dict[str, Any]`
- 前端：React + TypeScript + Vite + react-konva + zustand + ECharts，格狀清單使用虛擬捲動
- 開發環境：docker-compose（mongo + redis + nginx（假圖片 + image_filter 縮圖）+ backend + frontend）
- `dev/seed.py` 產生假的 Lot、圖片和標註，**刻意包含有問題的框**，用來測試可疑框檢查
- 登入：帳號密碼 + JWT（預設，尚未確認）
- 部署：Linux + docker-compose（預設，尚未確認）

## 3. 專案骨架（規劃）

```
defect-labeler/
├── docker-compose.yml, .env.example
├── backend/
│   ├── pyproject.toml
│   ├── config/source.yaml
│   └── app/
│       ├── main.py
│       ├── core/          config.py, db.py, cache.py, security.py
│       ├── models/        annotation.py, project.py, user.py
│       ├── api/           auth.py, projects.py, lots.py, annotations.py, stats.py, defects.py, export.py
│       │                  （不需要 images.py，圖片由 nginx 提供）
│       ├── repositories/  base.py, lot_source.py, annotation.py, lot.py, project.py
│       ├── services/      lot_opener.py, url_mapper.py, locking.py, queue.py, batch_edit.py, yolo_export.py
│       └── tests/
├── frontend/src/
│   ├── api/
│   ├── pages/        Home, LotView, Annotate, History, Stats, DefectView, Login, Admin
│   ├── components/   canvas/, ClassPicker, AttributeForm
│   ├── hooks/        useLock, useHotkeys, useHistory
│   └── store/
├── dev/      seed.py, nginx.conf
└── docs/     design.md
```

### config/source.yaml（既有資料來源的對應，目前是範例值）
```yaml
source:
  mongo_collection: images
  redis_key: "{lot}"
  redis_ttl: 86400
  fields: {id: _id, lot: lot, path: path, width: width, height: height}
  meta: {}                 # 其他要帶進標註文件 meta 的欄位
  ai: {result: ai_result, score: ai_score, model: ai_model}  # AI 分類結果欄位（欄位名稱待確認）
  split_group_by: meta.lot # YOLO train/val 分組依據
url_rules:
  - match: "^/data/(.*)$"
    replace: "https://img.your-company/\\1"
```
> Mongo 的樣本文件和 nginx 的 URL 規則尚未提供，先用設定檔佔位。

---

## 4. Redis 設計

### 既有 Lot 快取（上萬張圖，拆成三個 key）
| Key | 型別 | 內容 |
|---|---|---|
| `{lot}:meta` | string | `{"schema_version":1,"count":N,"cached_at":...,"complete":true}`，**最後寫入** |
| `{lot}:images` | hash | image_id → JSON（與 Mongo 相同格式；ObjectId → 字串，ISODate → ISO 8601） |
| `{lot}:order` | list | image_id 的順序 |

- 使用 pipeline 寫入，每批 1000 筆。
- 讀取時，`meta` 不存在或 `complete != true` 就視為快取未命中。

### 我們自己的 key（前綴 `dl:`）
| Key | 用途 |
|---|---|
| `dl:queue:{lot}` | 待標註的 annotation id。LPOP 取出後再加鎖 |
| `dl:lock:ann:{id}` | 編輯鎖，`SET NX EX 300`。續約與釋放用 Lua 腳本，只有持有者能操作 |
| `dl:fill:{lot}` | 回填快取鎖，`SET NX EX 10`，防止快取擊穿 |
| `dl:online:{lot}` | 目前線上的使用者 |
| `dl:stats:{hash}` | 統計結果快取，TTL 60 秒，儲存標註時刪除 |

### 快取規則
- 未命中時查 Mongo，並以 TTL 回填 Redis。
- 寫入時**先更新 Mongo，再刪除快取**，不要直接覆寫快取。
- Redis 故障時**降級為直接讀 Mongo**。
- 版本檢查一律在 Mongo 做，不依賴快取。

---

## 5. MongoDB 設計

### annotations（標註結果，每張圖一筆）
```json
{
  "_id": ObjectId,
  "project_id": ObjectId,
  "image_id": "原始圖片 id",
  "lot": "L2026110",
  "image": { "path": "", "filename": "", "width": 0, "height": 0,
             "channels": 3, "format": "png", "file_size": 0, "md5": "" },
  "meta":  { "product": "", "lot": "", "station": "", "captured_at": "" },
  "extra": {},
  "ai": { "result": "OK | <class_id>", "score": 0.92, "model": "" },
  "ai_cmp": "escape | overkill | mismatch | null",
  "verdict": "OK | NG",
  "defect_count": 2,
  "defects": [
    { "id": "uuid", "class_id": 0, "class_name": "scratch",
      "bbox": { "x": 0, "y": 0, "w": 0, "h": 0 },
      "attributes": {},
      "source": "human | model", "score": null }
  ],
  "status": "unassigned | in_progress | submitted | approved | rejected | reopened",
  "assignee": ObjectId, "reviewer": ObjectId, "review_comment": "",
  "version": 1,
  "created_at": ISODate,
  "annotated_by": ObjectId, "annotated_at": ISODate,
  "updated_by": ObjectId, "updated_at": ISODate
}
```
- bbox 使用**原圖像素座標 `{x, y, w, h}`**（左上角＋寬高，整數），匯出時才轉成 YOLO 格式。
- **圖片尺寸固定 300×300**。
- **儲存時記錄框圖人員與時間，以整張圖為單位**（由後端依 JWT 登入者與伺服器時間寫入，不採用前端傳來的值；個別的框不記錄）：
  - 第一次儲存：`annotated_by` / `annotated_at`，這張圖所有標記結果共用這個時間
  - 之後有修改再儲存：`updated_by` / `updated_at`（每次修改覆寫為最新一次），`annotated_*` 不變
  - 每一次儲存的人員與時間都保留在 `annotation_history` 的 `by` / `at`
  - 只用於顯示（標註頁的選取框與圖片資訊），**不做人員統計、不提供依人員篩選**
- `ai` 在開啟 Lot 時從來源資料帶入，之後不修改。
- `ai_cmp` 由後端在每次儲存時計算（以人工判定為準）：
  - `escape` 逃漏：AI 判 OK，人工判 NG
  - `overkill` 過殺：AI 判缺點，人工判 OK
  - `mismatch` 類別不符：兩邊都 NG，但 AI 類別不在人工框的類別裡（是否保留待確認）
  - 未標註為 `null`
- 編輯鎖放在 Redis，文件中不存鎖的欄位。
- 圖片寬高：固定 300×300（仍保留 `image.width/height` 欄位；Mongo 有值就用 Mongo 的值）。

### 其他 collection
- **projects**：`classes: [{id, name, display, color, description, example_urls, active}]`
  - **class id 固定，永不重新排序**。停用的類別設 `active:false`，保留原本的位置。
  - **類別數量很多**（數十種以上），任何選類別的地方都用「輸入搜尋 → 顯示建議清單點選」：可用中文名稱、英文代碼或 id 搜尋，開頭符合的排前面，↑↓ 選擇、Enter 確定。
  - `defect_attributes: [{key, type, options, required}]`、`review_required`
- **lots**：`{project_id, lot, image_count, status(initializing/open/in_progress/submitted/approved), assignees, progress{done, ok, ng}, last_exported_at, extra}`
- **annotation_history**：`{annotation_id, lot, version, action(save/submit/approve/reject/reopen/restore/batch_edit), batch_id, verdict, defects 完整快照, by, at, comment}`
- **batch_ops**：批次修正紀錄（見第 9 節）
- **users**：`{username, password_hash, role(annotator/reviewer/admin), active}`

### 索引
- annotations：`(project_id, image_id)` unique、`(project_id, status, assignee)`、`(lot, status, _id)`、`(lot, verdict, _id)`、`(lot, defects.class_id, _id)`、`(lot, updated_by, _id)`、`(lot, ai.result, _id)`、`(lot, ai_cmp, _id)`
- annotation_history：`(annotation_id, version -1)`、`(batch_id)`
- users：`username` unique

---

## 6. 核心流程

### 開啟 Lot
1. 使用者輸入 Lot，系統先查詢並顯示圖片數量，確認後再開啟；找不到 Lot 時顯示錯誤。
2. `POST /lots/{lot}/open` → 狀態設為 `initializing` → 背景以每批 1000 筆 bulk upsert 建立 annotations → 狀態設為 `open` → 建立 `dl:queue:{lot}`。
3. unique index `(project_id, image_id)` 確保重複開啟不會產生重複資料。

### 儲存（樂觀鎖）
- `updateOne({_id, version: N}, {$set: ..., $inc: {version: 1}})`，沒有符合的文件就回傳 **409**。
- 儲存時**整個 `defects` 陣列一起替換**。
- `defect_count` 和 `verdict` 由後端計算：**儲存時有框就是 NG，沒框就是 OK**（標註頁沒有判定按鈕）。**不使用「不確定」概念**：沒有 `unclear` 判定，也沒有 `uncertain` 框。尚未儲存過的圖 verdict 為空。
- 每次儲存都寫入 annotation_history，並刪除相關快取。

### 狀態流程
```
unassigned → in_progress → submitted → approved
                 ↑              │
                 └── rejected ←─┘
approved → reopened（修改已核准的圖，需要重新審核）
```

### 清單與瀏覽
- 使用 **cursor 分頁**，不使用 skip。
- 篩選條件放在 **URL query string**。
- 清單頁篩選項目：**判定、缺點類別、AI 結果、AI vs 人工（逃漏／過殺／類別不符）**，每個選項顯示張數，並和其他條件連動。**不提供狀態篩選**。
- 清單圖格顯示：縮圖＋框（選了類別時其他類別的框變淡）、🔒 誰正在編輯、序號；下方兩行：檔名＋框數；人工判定＋AI 結果（含逃漏／過殺標示）。**圖格上不顯示狀態**。
- 縮圖大小可切換小／中／大，可關閉框的顯示。
- 缺點類別、AI 結果篩選：只顯示張數最多的 8 個類別（AI 另含 OK），其餘用搜尋選取（建議清單顯示各類別張數）。
- 上一張／下一張只在**目前篩選結果**內移動。
- 標註頁：**進入即為編輯模式，沒有唯讀模式**；**不做縮放與平移**，圖片固定符合畫布；編輯時直接在圖上拖曳畫框（拖框移動、拖控制點調整大小）。**沒有左側功能列**（復原／重做只用 Ctrl+Z / Ctrl+Shift+Z）；中間畫布；右側面板（框圖／修改紀錄與 AI 結果、類別、缺點清單、選取框的 x, y, w, h、圖片資訊）。**不提供判定按鈕與快捷鍵說明**；選取框詳細內容只有 x, y, w, h。
  - 尚未標註的圖即使沒畫框也能直接儲存（記為 OK），方便快速處理無缺點的圖。
  - 類別：顯示目前類別＋搜尋輸入框（`/` 聚焦）＋「最近使用」類別（最多 8 個，快捷鍵 1–8）。有選取框時改的是該框的類別。
  - 右側面板最上方固定顯示這張圖先前的**框圖人員／時間**與**修改人員／時間**。
  - 進入頁面即自動取得編輯鎖，停留期間自動續約（心跳），離開時釋放。別人持有鎖時畫面會被遮住，提示「誰正在編輯」並提供回清單／下一張。
  - **不提供影像調整**（亮度、對比）。
  - 上方按鈕：還原（回到上次儲存）、儲存、儲存並下一張。
  - 「儲存並下一張」（Ctrl+Enter）；有未儲存修改時切換圖片會先確認。
  - 「開始標註」走佇列模式：只在未標註且沒人鎖定的圖之間移動，進入時自動取得編輯鎖。
  - 從缺點檢視頁進入時帶 `box=<defect id>`，自動選取該框。

---

## 7. 頁面與路由

| 路由 | 頁面 |
|---|---|
| `/` | **主頁只有兩個入口：輸入 Lot、缺點分布統計連結** |
| `/lots/:lot?verdict=&class_id=&ai=&ai_cmp=` | Lot 圖片清單與篩選 |
| `/lots/:lot/a/:annId` | 標註頁（進入即編輯，自動取得鎖） |
| `/lots/:lot/a/:annId/history` | 歷史版本，可比較和還原 |
| `/stats?lots=` | 缺點分布統計 |
| `/defects/:class?lots=&status=&mode=` | 缺點檢視頁（可在這裡做批次修正） |

### 統計頁 `/stats`
- 總覽：圖片數、NG/OK/未標註、框數
- AI vs 人工：逃漏率、過殺率（待確認是否加入）
- 各類別分布：**框數與圖片數**；每個類別都可以點進 `/defects/:class`
- 框尺寸分布直方圖、位置熱力圖（20×20）、每張圖的缺點數分布
- **可疑框檢查**（閾值寫在設定檔），也可以點進對應清單：
  - 極小框（< 5px）、超大框（> 圖片 30%）、超出邊界
  - 同類別重疊（IoU > 0.9，用 Python 計算）
  - 長寬比 > 20、NG 但沒有框
- **不提供任何標註人員相關統計**

### 缺點檢視頁 `/defects/:class`
- **裁切模式（預設）**：每個框一格，可依面積排序並顯示尺寸，可疑框標示 ⚠
  - 使用 CSS background-position/size 顯示裁切區域（padding 預設 50%，最小 32px，尚未確認）；如果太慢，之後再導入 imgproxy
- **整張圖模式**：每張圖一格，標出該類別的框
- 點擊格子後打開標註頁，並選取該框；上一張／下一張在這個缺點集合內移動

---

## 8. API

```
POST /auth/login
GET/POST /projects
POST /lots/{lot}/open
GET  /lots/{lot}
GET  /lots/{lot}/annotations?verdict=&class_id=&ai=&ai_cmp=&cursor=&limit=
GET  /lots/{lot}/facets?verdict=&class_id=&ai=&ai_cmp=   # 各篩選選項的張數
GET  /annotations/{id}/neighbors
GET  /annotations/{id}
PUT  /annotations/{id}                      # 帶 version，衝突時回傳 409
POST /annotations/{id}/lock                 # 取得、續約、釋放
POST /annotations/{id}/submit | approve | reject | reopen
GET  /annotations/{id}/history[/{version}]
POST /annotations/{id}/restore/{version}
GET  /stats?lots=&status=                   # 沒有標註人員參數
GET  /stats/suspicious?rule=&cursor=
GET  /defects?class_id=&lots=&mode=box|image&sort=area&cursor=&limit=100
POST /defects/batch
POST /defects/batch/{batch_id}/undo
POST /projects/{id}/export/yolo
```

---

## 9. 批次修正（在缺點檢視頁的裁切模式中）

**流程：選取 → 選擇操作 → 確認 → 查看結果 →（需要時）整批復原**

- 選取方式：點擊、Shift + 點擊選範圍、拖曳框選、Ctrl+A、空白鍵放大預覽、雙擊打開標註頁（返回後選取狀態仍保留）
- 可以批次執行的操作：**改類別、刪除、設定屬性**
- **框的位置和大小不提供批次修改**，要進標註頁逐一調整
- 確認對話框：列出影響的框數、圖片數、Lot 數，以及「已核准的圖會變成 reopened」；**修改原因必填**；刪除需要再確認一次
- 執行結果：顯示成功數和跳過數（列出原因，例如誰正在編輯），提供「重試跳過的項目」和「復原這次修改」
- 修改後，格子先變灰並標示「→ 新類別」，重新整理後才從清單中移除

**後端**：依 annotation 分組，每張圖執行：
1. `SET dl:lock:ann:{id} NX EX 30`，有人正在編輯就跳過
2. 從 Mongo 讀取最新版本
3. 套用修改；如果狀態是 approved，改成 reopened
4. 以 version 條件更新，發生衝突就跳過
5. 寫入 annotation_history（附上 `batch_id` 和原因）
6. 釋放鎖、刪除快取

- 超過 50 張圖時改成背景作業，前端顯示進度條
- **整批復原**：把這批中的每張圖還原到修改前的版本。若某張圖在批次修改後又被別人改過，就跳過那張，並列出被跳過的圖
- 單次批次上限 500 個框（寫在設定檔）
- 只有審核者和管理員可以使用批次修正（可以調整）

`batch_ops` 文件：
```json
{ "_id": "batch_id", "action": "change_class", "params": {"from": 0, "to": 1},
  "comment": "", "by": ObjectId, "at": ISODate,
  "results": [ {"annotation_id": "", "defect_ids": [], "from_version": 5, "to_version": 6, "ok": true},
               {"annotation_id": "", "ok": false, "reason": "locked_by:Ben"} ],
  "undone": false }
```

---

## 10. YOLO 匯出

- **只匯出 approved 的圖**
- 座標轉換：`cx=(x+w/2)/W, cy=(y+h/2)/H, nw=w/W, nh=h/H`（W=H=300）
- 框裁切到圖片範圍內，小於 1px 的框丟棄
- OK 圖輸出**空的 txt**，並用比例上限做抽樣
- `data.yaml` 的 names 依固定的 class id 排序，停用的類別保留位置
- train/val 依 `meta.lot` 的 hash 分組切分，避免同批資料同時出現在兩邊
- 可選：針對小缺點做切圖（tiling）
- `lots` 記錄最後匯出時間；匯出後如果有修改，要顯示警告

---

## 11. nginx 注意事項
- 目前不做影像調整，canvas 不需要讀取像素；若之後要做像素濾鏡，需要 `Access-Control-Allow-Origin` 加上 `crossOrigin="anonymous"`
- 建議前端和圖片使用**同一個網域**，避免 CORS 問題

---

## 12. 里程碑

1. **M1** 骨架、登入、輸入 Lot、Redis／Mongo 讀取
2. **M2** 標註主流程（畫框、選類別、儲存、鎖、佇列）
3. **M3** 清單篩選、歷史紀錄、修正流程
4. **M4** 缺點分布統計 + 可疑框 + 缺點檢視頁
5. **M5** 批次修正
6. **M6** 審核、權限
7. **M7** YOLO 匯出

## 13. 待確認事項
- [x] 專案位置：`/Users/weichun/Desktop/Program/labelimg/defect-labeler/`
- [ ] Mongo 樣本文件格式、nginx 路徑轉 URL 規則
- [ ] nginx 能否提供縮圖
- [ ] 裁切 padding（預設 50%，最小 32px）
- [ ] 誰可以修改已核准的圖（建議：任何人都能 reopen，但需要重新審核）
- [ ] 統計範圍：單一 Lot，還是跨 Lot／日期區間
- [ ] 是否需要更多可疑框規則
- [ ] 批次修正的權限
- [x] 先做可點擊的 HTML 原型（`labelImg/prototype/`：主頁、Lot 清單、標註頁已完成；接著做統計頁、缺點檢視頁、歷史頁）
- [ ] Lot 格式的 x 是否只限數字，或某幾段有固定規則
- [ ] AI 結果是每張圖一個分類，還是 AI 也會給框；在 Mongo 的欄位名稱
- [ ] 是否需要依 AI 信心分數篩選
- [ ] 「類別不符」是否保留
- [ ] 統計頁是否加入逃漏率／過殺率
- [ ] 登入方式（預設帳號密碼 + JWT）、部署方式（預設 Linux + docker-compose）
