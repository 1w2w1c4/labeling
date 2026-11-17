# 缺點偵測標註系統（Defect Labeler）

類似 labelme 的網頁標註工具，前後端都要做，用途是 **AVI 缺點偵測**的框圖標註與修正。

> 狀態：設計討論已完成，可點擊的 HTML 原型（`labelImg/prototype/`）已完成，尚未開始寫正式程式。
> 正式程式位置：`/Program/labelimg/defect-labeler/`（目前只有設定檔 `backend/config/classes.yaml`、`users.yaml`）
> GitHub：https://github.com/1w2w1c4/labeling

# python3 -m http.server 8000

## 回覆語言
與使用者溝通時使用**繁體中文**。

---

## 1. 需求摘要

- 只有一個專案：**AVI**。頂部列顯示標題 AVI，不提供切換專案。
- 資料來源是**既有的 MongoDB**，前面有**既有的 Redis** 作為快取：先讀 Redis，找不到才查 Mongo（cache-aside）。
- Redis 的 key 是 **Lot**。我們可以寫入 Redis，也可以建立自己的 key。
- **圖片檔由 nginx 提供**。Mongo/Redis 只存圖片基本資料（含路徑），路徑轉 URL 有轉換規則。
- **只做 bounding box**。
- 標註結果存到**另一個 collection**。
- **多人協作**：多人分工標同一個 Lot。
- 以 **Lot** 為工作單位，一個 Lot 可能有**上萬張圖**。入口要能輸入 Lot。
- **Lot 格式固定為 `xxxxxx-xx-xx`**（目前假設 x 為英數字，regex `^[A-Z0-9]{6}-[A-Z0-9]{2}-[A-Z0-9]{2}$`）。前端輸入時自動轉大寫並補 `-`，格式不對不能送出；後端 API 也要驗證。
- 來源資料帶有 **AI 分類結果**（每張圖一個：`OK` 或某個缺點類別，加信心分數）。Lot 清單可依 AI 結果篩選，並和人工判定比對出 **逃漏 / 過殺**。
- 每筆標註存：**圖片基本資訊、缺點位置、缺點名稱**。一張圖可以有**多個缺點**。
- schema **保留欄位彈性**。
- 需要能**檢查並修正先前的框圖結果**；修正一律在標註頁**逐張**進行。
- 要有**缺點分布統計頁**，從各個缺點點進去，直接看到所有框過該缺點的圖。
- **只保留最後版本**，每張圖只記錄**最後一次修改的人員與時間**。
- **不做標註人員的統計**（不統計每個人標了多少張，也不提供依標註人員篩選）。

### 已決定不做
| 項目 | 說明 |
|---|---|
| 登入、選擇使用者頁面 | 不做。身分由另一個地方取得，`config/users.yaml` 只管理權限（見第 3 節） |
| 審核流程 | 沒有送審／核准／退回，也沒有 status 欄位；儲存後即為最終結果 |
| 歷史版本 | 不存歷史（沒有 annotation_history），沒有歷史版本頁與還原 |
| 管理頁 | 不做。缺點類別由設定檔維護 |
| 切換專案 | 只有 AVI 一個專案 |
| YOLO 匯出 | 不做 |
| 缺點檢視頁 `/defects/:class`、批次修正 | 不做，改用「類別圖片清單」＋標註頁逐張修正 |
| 統計頁的 Lot 選擇、AI vs 人工、框尺寸／位置熱力圖／每張圖缺點數、可疑框檢查 | 不做 |
| 影像調整（亮度、對比）、縮放與平移 | 不做 |

## 2. 技術選型

- 後端：FastAPI + Motor（async Mongo）+ redis.asyncio + Pydantic
  - 核心欄位嚴格驗證；`meta` / `extra` / `attributes` 使用 `dict[str, Any]`
- 前端：React + TypeScript + Vite + react-konva + zustand + ECharts，格狀清單使用虛擬捲動
- 開發環境：docker-compose（mongo + redis + nginx（假圖片 + image_filter 縮圖）+ backend + frontend）
- `dev/seed.py` 產生假的 Lot、圖片和標註
- 部署：Linux + docker-compose（預設，尚未確認）

## 3. 專案骨架（規劃）

```
defect-labeler/
├── docker-compose.yml, .env.example
├── backend/
│   ├── pyproject.toml
│   ├── config/        source.yaml, classes.yaml, users.yaml
│   └── app/
│       ├── main.py
│       ├── core/          config.py, db.py, cache.py, identity.py
│       ├── models/        annotation.py, lot.py, defect_class.py, user.py
│       ├── api/           lots.py, annotations.py, stats.py, classes.py, users.py
│       │                  （不需要 images.py，圖片由 nginx 提供）
│       ├── repositories/  base.py, lot_source.py, annotation.py, lot.py
│       ├── services/      lot_opener.py, url_mapper.py, locking.py, queue.py
│       └── tests/
├── frontend/src/
│   ├── api/
│   ├── pages/        Home, LotView, Annotate, Stats, ClassImages
│   ├── components/   canvas/, ClassPicker
│   ├── hooks/        useLock, useHotkeys, useUndo
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
url_rules:
  - match: "^/data/(.*)$"
    replace: "https://img.your-company/\\1"
```
> Mongo 的樣本文件和 nginx 的 URL 規則尚未提供，先用設定檔佔位。

### config/classes.yaml（缺點類別，沒有管理頁，改設定檔後重啟生效）
實際檔案：[`defect-labeler/backend/config/classes.yaml`](defect-labeler/backend/config/classes.yaml)（目前 38 類；原型也直接讀這個檔案）。格式：
```yaml
classes:
  - {id:  0, name: scratch, display: 刮傷, color: "#e5484d"}
  - {id:  5, name: bubble,  display: 氣泡, color: "#7c8594", active: false}
```
- **class id 固定，永不重新排序，不能刪除**。停用的類別設 `active: false`，保留原本的位置（舊的框仍顯示，但不能再選來畫新框）。
- **類別數量很多**（數十種以上），任何選類別的地方都用「輸入搜尋 → 顯示建議清單點選」：可用中文名稱、英文代碼或 id 搜尋，開頭符合的排前面，↑↓ 選擇、Enter 確定。

### config/users.yaml（使用者權限，改設定檔後重啟生效）
實際檔案：[`defect-labeler/backend/config/users.yaml`](defect-labeler/backend/config/users.yaml)。格式：
```yaml
roles:
  editor: [view, open_lot, annotate]   # 可開啟 Lot、框圖與修改
  viewer: [view]                       # 只能看清單、標註頁與統計
users:
  - {id: weichun, name: weichun, role: editor}
  - {id: eric,    name: Eric,    role: viewer}
  - {id: frank,   name: Frank,   role: editor, active: false}
```
- **身分由另一個地方取得**（不做登入，也不做選擇使用者的頁面）；本系統只用 users.yaml 管理**誰有哪些權限**。外部身分如何傳進來待確認（見第 11 節）。
- `id` 對應外部身分，固定不變，存進 `updated_by` 與編輯鎖；`name` 是畫面顯示的名字（改名只改 name）。
- 權限：
  | 權限 | 能做什麼 |
  |---|---|
  | `view` | 看主頁、Lot 清單、標註頁、統計頁、類別圖片清單 |
  | `open_lot` | 開啟新的 Lot（`POST /lots/{lot}/open`） |
  | `annotate` | 取得編輯鎖、儲存標註（`POST .../lock`、`PUT /annotations/{id}`） |
- 後端每個 API 檢查權限：不在清單或 `active: false` 回 **401**；權限不足回 **403**。前端依權限隱藏或停用對應按鈕。
- **不能刪除**，不再使用設 `active: false`：失去所有權限，但舊紀錄照常顯示名字。

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
| `dl:lock:ann:{id}` | 編輯鎖，`SET NX EX 300`，值為使用者 id。續約與釋放用 Lua 腳本，只有持有者能操作 |
| `dl:fill:{lot}` | 回填快取鎖，`SET NX EX 10`，防止快取擊穿 |
| `dl:online:{lot}` | 目前線上的使用者 |
| `dl:stats` | 統計結果快取，TTL 60 秒，儲存標註時刪除 |

### 快取規則
- 未命中時查 Mongo，並以 TTL 回填 Redis。
- 寫入時**先更新 Mongo，再刪除快取**，不要直接覆寫快取。
- Redis 故障時**降級為直接讀 Mongo**。
- 版本檢查一律在 Mongo 做，不依賴快取。

---

## 5. MongoDB 設計

### annotations（標註結果，每張圖一筆，只存最後版本）
```json
{
  "_id": ObjectId,
  "image_id": "原始圖片 id",
  "lot": "202611-01-03",
  "image": { "path": "", "filename": "", "width": 300, "height": 300,
             "channels": 3, "format": "png", "file_size": 0, "md5": "" },
  "meta":  { "product": "", "station": "", "captured_at": "" },
  "extra": {},
  "ai": { "result": "OK | <class_id>", "score": 0.92, "model": "" },
  "ai_cmp": "escape | overkill | mismatch | null",
  "verdict": "OK | NG | null",
  "defect_count": 2,
  "defects": [
    { "id": "uuid", "class_id": 0, "class_name": "scratch",
      "bbox": { "x": 0, "y": 0, "w": 0, "h": 0 },
      "attributes": {} }
  ],
  "version": 1,
  "created_at": ISODate,
  "updated_by": "使用者 id（users.yaml）", "updated_at": ISODate
}
```
- bbox 使用**原圖像素座標 `{x, y, w, h}`**（左上角＋寬高，整數）。
- **圖片尺寸固定 300×300**（仍保留 `image.width/height` 欄位；Mongo 有值就用 Mongo 的值）。
- **只記錄最後一次修改的人員與時間，以整張圖為單位**：每次儲存覆寫 `updated_by` / `updated_at`（`updated_by` 為目前使用者的 id，顯示時換成 users.yaml 的 name；時間由後端寫入伺服器時間；個別的框不記錄；不保留之前的紀錄）。只用於標註頁顯示，**不做人員統計、不提供依人員篩選**。
- `version` 只用於樂觀鎖。
- `ai` 在開啟 Lot 時從來源資料帶入，之後不修改。
- `ai_cmp` 由後端在每次儲存時計算（以人工判定為準），用於 Lot 清單篩選：
  - `escape` 逃漏：AI 判 OK，人工判 NG
  - `overkill` 過殺：AI 判缺點，人工判 OK
  - `mismatch` 類別不符：兩邊都 NG，但 AI 類別不在人工框的類別裡（是否保留待確認）
  - 未標註為 `null`
- 編輯鎖放在 Redis，文件中不存鎖的欄位。

### lots
`{lot, image_count, status(initializing/open), progress{done, ok, ng}, extra}`

### 索引
- annotations：`image_id` unique、`(lot, verdict, _id)`、`(lot, defects.class_id, _id)`、`(defects.class_id, lot, _id)`（類別圖片清單跨 Lot 查詢）、`(lot, ai.result, _id)`、`(lot, ai_cmp, _id)`

---

## 6. 核心流程

### 開啟 Lot
1. 使用者輸入 Lot，系統先查詢並顯示圖片數量，確認後再開啟；找不到 Lot 時顯示錯誤。
2. `POST /lots/{lot}/open` → 狀態設為 `initializing` → 背景以每批 1000 筆 bulk upsert 建立 annotations → 狀態設為 `open` → 建立 `dl:queue:{lot}`。
3. unique index `image_id` 確保重複開啟不會產生重複資料。

### 儲存（樂觀鎖）
- `updateOne({_id, version: N}, {$set: ..., $inc: {version: 1}})`，沒有符合的文件就回傳 **409**。
- 儲存時**整個 `defects` 陣列一起替換**，直接覆寫為最新版本。
- `defect_count` 和 `verdict` 由後端計算：**儲存時有框就是 NG，沒框就是 OK**（標註頁沒有判定按鈕）。**不使用「不確定」概念**：沒有 `unclear` 判定，也沒有 `uncertain` 框。尚未儲存過的圖 verdict 為空。
- 同時寫入 `updated_by` / `updated_at`，並刪除相關快取（含 `dl:stats`）。

---

## 7. 頁面與路由

| 路由 | 頁面 | 原型檔案 |
|---|---|---|
| `/` | 主頁：只有兩個入口——輸入 Lot、缺點分布統計 | `index.html` |
| `/lots/:lot?verdict=&class_id=&ai=&ai_cmp=` | Lot 圖片清單與篩選 | `lot.html` |
| `/lots/:lot/a/:annId` | 標註頁（進入即編輯，自動取得鎖） | `annotate.html` |
| `/stats` | 缺點分布統計（範圍固定為全部 Lot） | `stats.html` |
| `/classes/:id/images` | 類別圖片清單：跨全部 Lot 列出框過該類別的圖 | `images.html?class_id=` |

頂部列（每頁共用）：品牌、標題 **Labelme**（不可點）、深淺色切換、目前使用者名稱（不可點）。

### 主頁 `/`
- 輸入 Lot：自動轉大寫並補 `-`，格式正確才能查詢；查詢後顯示圖片數量、產品／站點、資料來源與標註進度。
- 未開啟的 Lot 先「開啟 Lot」（顯示初始化進度）；已開啟的可「看圖片清單」或「開始標註」。
- 缺點分布統計入口卡片。

### Lot 圖片清單 `/lots/:lot`
- 上方：Lot 概要、標註進度（NG／OK／未標）、「缺點分布統計」連結、「開始標註」。
- 使用 **cursor 分頁**、虛擬捲動，不使用 skip；篩選條件放在 **URL query string**。
- 篩選項目：**判定、缺點類別、AI 結果、AI vs 人工（逃漏／過殺／類別不符）**，每個選項顯示張數，並和其他條件連動。不提供狀態篩選。
- 缺點類別、AI 結果篩選：只顯示張數最多的 8 個類別（AI 另含 OK），其餘用搜尋選取（建議清單顯示各類別張數）；被選中的類別一定顯示。
- 圖格：縮圖＋框（選了類別時其他類別的框變淡）、🔒 誰正在編輯、序號；下方兩行：檔名＋框數；人工判定＋AI 結果（含逃漏／過殺標示）。
- 縮圖大小可切換小／中／大，可關閉框的顯示。

### 標註頁 `/lots/:lot/a/:annId`
- **進入即為編輯模式**；**不做縮放與平移**，圖片固定符合畫布；直接在圖上拖曳畫框（拖框移動、拖控制點調整大小）。
- 版面：上方列（回清單、檔名、上一張／下一張與位置、儲存相關按鈕）；中間畫布；右側面板。**沒有左側功能列**，復原／重做只用 Ctrl+Z / Ctrl+Shift+Z。**不提供判定按鈕與快捷鍵說明**。
- 右側面板：最上方固定顯示**最後修改人員／時間**與 AI 結果；類別；缺點清單；選取框的 x, y, w, h；圖片資訊。
- 類別：顯示目前類別＋搜尋輸入框（`/` 聚焦）＋「最近使用」類別（最多 8 個，快捷鍵 1–8）。有選取框時改的是該框的類別。
- 上方按鈕：還原（回到上次儲存）、儲存、儲存並下一張（Ctrl+Enter）；有未儲存修改時切換圖片會先確認。
- 尚未標註的圖即使沒畫框也能直接儲存（記為 OK），方便快速處理無缺點的圖。
- 進入頁面即自動取得編輯鎖，停留期間自動續約（心跳），離開時釋放。別人持有鎖時畫面會被遮住，提示「誰正在編輯」並提供回清單／下一張。
- 上一張／下一張與「回清單」依進入來源而定：
  | 進入來源 | 上一張／下一張 | 回清單 |
  |---|---|---|
  | Lot 清單 | 該 Lot 目前篩選結果內 | Lot 清單（保留篩選） |
  | 開始標註（`queue=1`） | 該 Lot 未標註且沒人鎖定的圖 | Lot 清單 |
  | 類別圖片清單（`from=class&class_id=`） | **跨全部 Lot、只在該類別內** | **類別圖片清單** |
- 帶 `box=<defect id>` 進入時自動選取該框。

### 統計頁 `/stats`
- **統計範圍固定為全部（已開啟的）Lot**，不提供 Lot 選擇；顯示「統計結果快取 60 秒 · 更新時間」與重新整理按鈕。
- 總覽：圖片數、已標註、NG、OK、未標註、框數（含每張 NG 平均框數），加一條 NG／OK 進度條。
- 各類別分布：**所有類別畫成一張橫條分布圖**，可切換**框數／圖片數**（依所選數值排序）；滑鼠移上去顯示框數與圖片數。
  - 點類別或右側「看 N 張 →」，打開該類別的**類別圖片清單**；沒有圖片的類別不能點。
  - 不顯示框佔比。
- **不提供任何標註人員相關統計**。

### 類別圖片清單 `/classes/:id/images`
- 跨全部 Lot 列出框過該類別的所有圖（cursor 分頁、虛擬捲動，與 Lot 清單相同的格狀版面）。
- **不顯示 Lot**、不提供 Lot 篩選；可直接切換到其他類別。
- 只標出該類別的框，其他類別的框變淡；圖格下方顯示該類別框數與總框數。
- 點圖打開標註頁（帶 `class_id`、`from=class`、`box`）。

---

## 8. API

```
GET  /classes                               # 缺點類別（來自 config/classes.yaml）
GET  /me                                    # 目前使用者的 id、name、role、權限（前端依此隱藏按鈕）
# 所有 API 都檢查 users.yaml：不在清單或已停用回 401，權限不足回 403
POST /lots/{lot}/open
GET  /lots/{lot}
GET  /lots/{lot}/annotations?verdict=&class_id=&ai=&ai_cmp=&cursor=&limit=
GET  /lots/{lot}/facets?verdict=&class_id=&ai=&ai_cmp=   # 各篩選選項的張數
GET  /annotations/{id}/neighbors            # 依進入來源（Lot 篩選／佇列／類別）回傳上一張、下一張
GET  /annotations/{id}
PUT  /annotations/{id}                      # 帶 version，衝突時回傳 409
POST /annotations/{id}/lock                 # 取得、續約、釋放
GET  /stats                                 # 範圍為全部 Lot；沒有標註人員參數
GET  /classes/{id}/images?cursor=&limit=    # 跨全部 Lot，框過該類別的圖
```

---

## 9. nginx 注意事項
- 不做影像調整，canvas 不需要讀取像素；若之後要做像素濾鏡，需要 `Access-Control-Allow-Origin` 加上 `crossOrigin="anonymous"`。
- 建議前端和圖片使用**同一個網域**，避免 CORS 問題。

---

## 10. 里程碑

1. **M1** 骨架、使用者身分、輸入 Lot、Redis／Mongo 讀取
2. **M2** 標註主流程（畫框、選類別、儲存、鎖、佇列）
3. **M3** Lot 清單篩選、修正流程
4. **M4** 缺點分布統計 + 類別圖片清單

## 11. 待確認事項
- [ ] 外部身分怎麼傳進本系統（例如 nginx／反向代理帶入的 header、SSO token、共用 cookie），以及 id 的格式
- [ ] Mongo 樣本文件格式、nginx 路徑轉 URL 規則
- [ ] nginx 能否提供縮圖
- [ ] Lot 格式的 x 是否只限數字，或某幾段有固定規則
- [ ] AI 結果是每張圖一個分類，還是 AI 也會給框；在 Mongo 的欄位名稱
- [ ] 是否需要依 AI 信心分數篩選
- [ ] 「類別不符」是否保留
- [ ] 部署方式（預設 Linux + docker-compose）

### 已確認
- 專案位置：`/Program/labelimg/defect-labeler/`
- 統計範圍：全部 Lot
- 使用者身分：由另一個地方取得，不做登入與選擇頁面；`config/users.yaml` 管理權限
- 缺點類別：用 `config/classes.yaml` 維護，不做管理頁
- 只有一個專案 AVI，不需要 `project_id`
- 原型：`labelImg/prototype/` 五頁（主頁、Lot 清單、標註頁、統計頁、類別圖片清單）已完成，原型的假資料與共用元件在 `common.js` / `common.css`

---

## 12. 原型說明（`labelImg/prototype/`）
- 純 HTML/JS。**要透過本機伺服器開啟**（瀏覽器不允許 file:// 讀 YAML）：在 `labelImg/` 執行 `python3 -m http.server 8000`，再開 http://localhost:8000/prototype/
- 資料是 `common.js` 依 Lot 產生的決定性假資料，儲存結果存在瀏覽器 localStorage。
- 範例 Lot：`202611-01-03`（已開啟、有標註）、`202611-02-01`（未開啟）。
- **缺點類別與使用者權限只改 YAML**：原型每次開頁面都直接讀 `defect-labeler/backend/config/classes.yaml`、`users.yaml`（用 js-yaml 4.1.0 解析），改完重新整理即可。YAML 有錯（讀不到、id 不連續、角色未定義）時整頁顯示錯誤訊息。
- 外部身分以 `common.js` 的 `EXTERNAL_USER_ID` 模擬（預設 weichun），改成 `eric`（viewer）可測試無權限時的行為。
- 原型裡的 `STATUS`、`lockedBy` 等欄位只是假資料用途，不代表正式版的 schema。
