import re
from datetime import datetime
from typing import Any, Literal

from fastapi import HTTPException, Path
from pydantic import BaseModel, Field

LOT_RE = re.compile(r"^[A-Z0-9]{6}-[A-Z0-9]{2}-[A-Z0-9]{2}$")


def lot_param(lot: str = Path(description="Lot 編號，格式 xxxxxx-xx-xx")) -> str:
    """路徑參數 {lot} 的驗證：轉大寫，格式不對回 422。"""
    value = lot.strip().upper()
    if not LOT_RE.fullmatch(value):
        raise HTTPException(422, f"Lot「{lot}」格式不正確，必須是 xxxxxx-xx-xx（6 碼-2 碼-2 碼英數字）")
    return value


# ---------- 來源資料 ----------


class SourceImage(BaseModel):
    """來源圖片資料經過 source.yaml 欄位對應後的結果。"""

    image_id: str
    lot: str
    seq: int = 0  # Lot 內的序號（從 1 開始，依來源順序），開啟 Lot 時給定
    path: str
    filename: str
    width: int
    height: int
    meta: dict[str, Any] = Field(default_factory=dict)
    ai: dict[str, Any] | None = None


class SourceSummary(BaseModel):
    count: int
    meta: dict[str, Any]  # 第一張圖的 meta（產品 / 站點）
    data_source: Literal["redis", "mongo"]


# ---------- lots collection ----------

LotStatus = Literal["initializing", "open", "failed"]


class LotRecord(BaseModel):
    lot: str
    status: LotStatus
    image_count: int = 0
    init_done: int = 0
    meta: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    opened_by: str | None = None
    created_at: datetime | None = None
    heartbeat_at: datetime | None = None
    opened_at: datetime | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


# ---------- API 回應 ----------


class Progress(BaseModel):
    total: int
    done: int
    ok: int
    ng: int


class InitProgress(BaseModel):
    done: int
    total: int


class LotInfo(BaseModel):
    """主頁查詢 Lot 的結果。

    status：
    - new：來源有這個 Lot，但還沒開啟
    - initializing：開啟中（init 為進度，前端輪詢 GET /lots/{lot}）
    - open：已開啟（progress 為標註進度）
    - failed：開啟失敗或中斷，可以重新開啟
    """

    lot: str
    status: Literal["new", "initializing", "open", "failed"]
    image_count: int
    meta: dict[str, Any]
    data_source: Literal["redis", "mongo", "annotations"]
    init: InitProgress | None = None
    progress: Progress | None = None
    online: int = 0
    error: str | None = None
