"""標註的讀取、儲存、清單、篩選選項、上一張／下一張、類別圖片清單。"""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from app.core.identity import CurrentUser, UserDirectory
from app.models.annotation import (
    AnnotationListItem,
    AnnotationOut,
    AnnotationPage,
    AnnotationSave,
    ClassImageItem,
    ClassImagePage,
    Defect,
    Facets,
    FacetCounts,
    Neighbors,
    UserRef,
)
from app.models.defect_class import ClassCatalog
from app.repositories.annotation import AnnotationRepo, ListFilter
from app.repositories.lot import LotRepo
from app.services.locking import LockService
from app.services.presence import Presence
from app.services.stats import StatsService
from app.services.url_mapper import UrlMapper

log = logging.getLogger(__name__)


# ---------- 錯誤（API 層轉成 HTTP 狀態碼） ----------


class NotFound(Exception):
    def __init__(self, message: str = "找不到這張圖"):
        super().__init__(message)
        self.message = message


class Invalid(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class Conflict(Exception):
    """版本衝突：別人已經先存了。"""

    def __init__(self, current: dict[str, Any] | None):
        self.current = current


class LockedByOther(Exception):
    def __init__(self, holder: UserRef):
        self.holder = holder


def compute_ai_cmp(verdict: str | None, ai: dict[str, Any] | None, class_ids: set[int]) -> str | None:
    """以人工判定為準：逃漏（AI OK、人工 NG）、過殺（AI 判缺點、人工 OK）、類別不符（都 NG 但 AI 類別不在人工框裡）。"""
    if verdict is None or not ai or ai.get("result") in (None, ""):
        return None
    result = str(ai["result"])
    ai_ok = result.upper() == "OK"
    if verdict == "NG" and ai_ok:
        return "escape"
    if verdict == "OK" and not ai_ok:
        return "overkill"
    if verdict == "NG" and not ai_ok:
        try:
            return None if int(result) in class_ids else "mismatch"
        except ValueError:
            return None  # AI 結果不是類別 id，無法比對類別
    return None


def encode_class_cursor(lot: str, seq: int) -> str:
    return f"{lot}|{seq}"


def decode_class_cursor(cursor: str) -> tuple[str, int]:
    try:
        lot, seq = cursor.rsplit("|", 1)
        return lot, int(seq)
    except ValueError:
        raise Invalid("cursor 格式不正確") from None


class AnnotationService:
    def __init__(
        self,
        annotations: AnnotationRepo,
        lots: LotRepo,
        locks: LockService,
        presence: Presence,
        stats: StatsService,
        classes: ClassCatalog,
        users: UserDirectory,
        url_for: UrlMapper,
    ):
        self.repo = annotations
        self.lots = lots
        self.locks = locks
        self.presence = presence
        self.stats = stats
        self.classes = classes
        self.users = users
        self.url_for = url_for

    # ---------- 轉換 ----------

    def user_ref(self, user_id: str | None) -> UserRef | None:
        return UserRef(id=user_id, name=self.users.display_name(user_id)) if user_id else None

    def _defects(self, doc: dict[str, Any]) -> list[Defect]:
        return [Defect.model_validate(d) for d in doc.get("defects") or []]

    def to_out(self, doc: dict[str, Any], locked_by: str | None) -> AnnotationOut:
        image = doc.get("image") or {}
        return AnnotationOut(
            id=str(doc["_id"]),
            lot=doc["lot"],
            seq=doc.get("seq", 0),
            image_id=doc["image_id"],
            url=self.url_for(image.get("path", "")),
            image=image,
            meta=doc.get("meta") or {},
            extra=doc.get("extra") or {},
            ai=doc.get("ai"),
            ai_cmp=doc.get("ai_cmp"),
            verdict=doc.get("verdict"),
            defect_count=doc.get("defect_count", 0),
            defects=self._defects(doc),
            version=doc["version"],
            created_at=doc.get("created_at"),
            updated_by=self.user_ref(doc.get("updated_by")),
            updated_at=doc.get("updated_at"),
            locked_by=self.user_ref(locked_by),
        )

    def _item_fields(self, doc: dict[str, Any], locked_by: str | None) -> dict[str, Any]:
        image = doc.get("image") or {}
        return dict(
            id=str(doc["_id"]),
            lot=doc["lot"],
            seq=doc.get("seq", 0),
            filename=image.get("filename", ""),
            url=self.url_for(image.get("path", "")),
            width=image.get("width", 0),
            height=image.get("height", 0),
            verdict=doc.get("verdict"),
            defect_count=doc.get("defect_count", 0),
            defects=self._defects(doc),
            ai=doc.get("ai"),
            ai_cmp=doc.get("ai_cmp"),
            locked_by=self.user_ref(locked_by),
        )

    # ---------- 單張 ----------

    async def get(self, ann_id: str) -> AnnotationOut:
        doc = await self.repo.get(ann_id)
        if doc is None:
            raise NotFound()
        return self.to_out(doc, await self.locks.holder(ann_id))

    def _validate_defects(self, body: AnnotationSave, old: dict[str, Any]) -> list[dict[str, Any]]:
        image = old.get("image") or {}
        width, height = int(image.get("width") or 0), int(image.get("height") or 0)
        old_class = {d.get("id"): d.get("class_id") for d in old.get("defects") or []}
        seen: set[str] = set()
        out: list[dict[str, Any]] = []
        for i, d in enumerate(body.defects, start=1):
            cls = self.classes.get(d.class_id)
            if cls is None:
                raise Invalid(f"第 {i} 個框的類別 id {d.class_id} 不存在")
            if not cls.active and old_class.get(d.id) != d.class_id:
                raise Invalid(f"類別「{cls.display}」已停用，不能用來畫新框")

            # 框裁切到圖片範圍內
            b = d.bbox
            x1, y1, x2, y2 = b.x, b.y, b.x + b.w, b.y + b.h
            if width and height:
                x1, x2 = max(0, min(x1, width)), max(0, min(x2, width))
                y1, y2 = max(0, min(y1, height)), max(0, min(y2, height))
            if x2 - x1 < 1 or y2 - y1 < 1:
                raise Invalid(f"第 {i} 個框太小或在圖片範圍外")

            defect_id = d.id if d.id and d.id not in seen else str(uuid.uuid4())
            seen.add(defect_id)
            out.append({
                "id": defect_id,
                "class_id": cls.id,
                "class_name": cls.name,
                "bbox": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
                "attributes": d.attributes,
            })
        return out

    async def save(self, ann_id: str, body: AnnotationSave, user: CurrentUser) -> AnnotationOut:
        old = await self.repo.get(ann_id)
        if old is None:
            raise NotFound()
        holder = await self.locks.holder(ann_id)
        if holder and holder != user.id:
            raise LockedByOther(self.user_ref(holder))

        defects = self._validate_defects(body, old)
        verdict = "NG" if defects else "OK"  # 儲存時有框就是 NG，沒框就是 OK
        fields = {
            "defects": defects,
            "defect_count": len(defects),
            "verdict": verdict,
            "ai_cmp": compute_ai_cmp(verdict, old.get("ai"), {d["class_id"] for d in defects}),
            "updated_by": user.id,
            "updated_at": datetime.now(UTC),
        }
        updated = await self.repo.save(ann_id, body.version, fields)
        if updated is None:
            current = await self.repo.get(ann_id)
            raise Conflict(self.to_out(current, holder).model_dump(mode="json") if current else None)

        await self.stats.invalidate()
        await self.presence.touch(old["lot"], user.id)
        return self.to_out(updated, holder)

    # ---------- Lot 清單 ----------

    async def require_open(self, lot: str) -> None:
        rec = await self.lots.get(lot)
        if rec is None or rec.status != "open":
            raise NotFound(f"Lot「{lot}」不存在或尚未開啟，請先回主頁開啟")

    async def list_lot(self, lot: str, flt: ListFilter, cursor: str | None, limit: int) -> AnnotationPage:
        await self.require_open(lot)
        try:
            after = int(cursor) if cursor else None
        except ValueError:
            raise Invalid("cursor 格式不正確") from None
        docs = await self.repo.list_lot(lot, flt, after, limit + 1)
        has_more = len(docs) > limit
        docs = docs[:limit]
        holders = await self.locks.holders([str(d["_id"]) for d in docs])
        items = [AnnotationListItem(**self._item_fields(d, holders.get(str(d["_id"])))) for d in docs]
        return AnnotationPage(
            items=items,
            next_cursor=str(docs[-1]["seq"]) if has_more else None,
            total=await self.repo.count_lot(lot, flt) if cursor is None else None,
        )

    async def facets(self, lot: str, flt: ListFilter) -> Facets:
        await self.require_open(lot)
        raw = await self.repo.facets(lot, flt)
        return Facets(**{k: FacetCounts(**v) for k, v in raw.items()})

    # ---------- 上一張／下一張 ----------

    async def neighbors_lot(self, ann_id: str, flt: ListFilter) -> Neighbors:
        doc = await self.repo.get(ann_id)
        if doc is None:
            raise NotFound()
        prev, nxt, position, total = await self.repo.neighbors_in_lot(doc["lot"], doc.get("seq", 0), flt)
        return self._neighbors(prev, nxt, position, total)

    async def neighbors_class(self, ann_id: str, class_id: int) -> Neighbors:
        doc = await self.repo.get(ann_id)
        if doc is None:
            raise NotFound()
        lots = await self.lots.open_lots()
        prev, nxt, position, total = await self.repo.neighbors_in_class(
            class_id, lots, doc["lot"], doc.get("seq", 0)
        )
        return self._neighbors(prev, nxt, position, total)

    @staticmethod
    def _neighbors(prev, nxt, position, total) -> Neighbors:
        return Neighbors(
            prev=str(prev["_id"]) if prev else None,
            next=str(nxt["_id"]) if nxt else None,
            prev_lot=prev["lot"] if prev else None,
            next_lot=nxt["lot"] if nxt else None,
            position=position,
            total=total,
        )

    # ---------- 類別圖片清單 ----------

    async def class_images(self, class_id: int, cursor: str | None, limit: int) -> ClassImagePage:
        if self.classes.get(class_id) is None:
            raise NotFound(f"類別 id {class_id} 不存在")
        after = decode_class_cursor(cursor) if cursor else None
        lots = await self.lots.open_lots()
        docs = await self.repo.list_class(class_id, lots, after, limit + 1)
        has_more = len(docs) > limit
        docs = docs[:limit]
        holders = await self.locks.holders([str(d["_id"]) for d in docs])
        items = [
            ClassImageItem(
                **self._item_fields(d, holders.get(str(d["_id"]))),
                class_boxes=sum(1 for x in d.get("defects") or [] if x.get("class_id") == class_id),
            )
            for d in docs
        ]
        return ClassImagePage(
            items=items,
            next_cursor=encode_class_cursor(docs[-1]["lot"], docs[-1]["seq"]) if has_more else None,
            total=await self.repo.count_class(class_id, lots) if cursor is None else None,
        )
