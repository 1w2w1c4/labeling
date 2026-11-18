from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

MAX_DEFECTS = 500  # 單張圖最多幾個框（防止誤送大量資料）


class BBox(BaseModel):
    """原圖像素座標：左上角 + 寬高（整數）。"""

    x: int
    y: int
    w: int
    h: int

    @field_validator("x", "y", "w", "h", mode="before")
    @classmethod
    def _round(cls, v):
        return round(v) if isinstance(v, float) else v


class DefectIn(BaseModel):
    id: str | None = None  # 新框可以不帶，後端產生
    class_id: int
    bbox: BBox
    attributes: dict[str, Any] = Field(default_factory=dict)


class AnnotationSave(BaseModel):
    version: int
    defects: list[DefectIn] = Field(max_length=MAX_DEFECTS)


class Defect(BaseModel):
    id: str
    class_id: int
    class_name: str = ""
    bbox: BBox
    attributes: dict[str, Any] = Field(default_factory=dict)


class UserRef(BaseModel):
    id: str
    name: str


class ImageInfo(BaseModel):
    path: str = ""
    filename: str = ""
    width: int = 0
    height: int = 0
    model_config = {"extra": "allow"}  # channels、format、file_size、md5 等之後可能補上


Verdict = Literal["OK", "NG"]
AiCmp = Literal["escape", "overkill", "mismatch"]


class AnnotationOut(BaseModel):
    """標註頁用的完整資料。"""

    id: str
    lot: str
    seq: int
    image_id: str
    url: str
    image: ImageInfo
    meta: dict[str, Any] = Field(default_factory=dict)
    extra: dict[str, Any] = Field(default_factory=dict)
    ai: dict[str, Any] | None = None
    ai_cmp: AiCmp | None = None
    verdict: Verdict | None = None
    defect_count: int = 0
    defects: list[Defect] = Field(default_factory=list)
    version: int
    created_at: datetime | None = None
    updated_by: UserRef | None = None
    updated_at: datetime | None = None
    locked_by: UserRef | None = None


class AnnotationListItem(BaseModel):
    """清單圖格用的精簡資料。"""

    id: str
    lot: str
    seq: int
    filename: str
    url: str
    width: int
    height: int
    verdict: Verdict | None = None
    defect_count: int = 0
    defects: list[Defect] = Field(default_factory=list)
    ai: dict[str, Any] | None = None
    ai_cmp: AiCmp | None = None
    locked_by: UserRef | None = None


class AnnotationPage(BaseModel):
    items: list[AnnotationListItem]
    next_cursor: str | None = None
    total: int | None = None  # 只有第一頁（沒帶 cursor）才計算


class FacetCounts(BaseModel):
    all: int  # 套用「其他」篩選條件後的總張數（「全部」按鈕的數字）
    counts: dict[str, int]  # 選項值 → 張數


class Facets(BaseModel):
    verdict: FacetCounts  # 選項：NG / OK / none
    class_id: FacetCounts  # 選項：類別 id（字串）
    ai: FacetCounts  # 選項：OK / 類別 id（字串）
    ai_cmp: FacetCounts  # 選項：escape / overkill / mismatch


class Neighbors(BaseModel):
    prev: str | None = None
    next: str | None = None
    prev_lot: str | None = None  # 類別模式會跨 Lot，前端組網址要用
    next_lot: str | None = None
    position: int | None = None  # 目前這張在集合中的位置（從 1 開始）
    total: int = 0


class LockState(BaseModel):
    held: bool  # 目前使用者是否持有鎖
    holder: UserRef | None = None  # 誰持有（包含自己）
    expires_in: int | None = None  # 剩幾秒
    degraded: bool = False  # Redis 無法使用：沒有鎖，只靠版本檢查避免覆蓋


class QueueNext(BaseModel):
    id: str | None  # None = 沒有待標註的圖了
    remaining: int  # 還有幾張未標註（含正在被別人編輯的）


class ClassStat(BaseModel):
    class_id: int
    boxes: int
    images: int


class StatsOut(BaseModel):
    images: int
    labeled: int
    ng: int
    ok: int
    unlabeled: int
    boxes: int
    avg_boxes_per_ng: float
    lots: int
    classes: list[ClassStat]
    cached_at: datetime


class ClassImageItem(AnnotationListItem):
    class_boxes: int  # 這張圖上該類別的框數


class ClassImagePage(BaseModel):
    items: list[ClassImageItem]
    next_cursor: str | None = None
    total: int | None = None
