"""annotations collection：每張圖一筆，只存最後版本。

排序與分頁一律用 (lot, seq)：seq 是 Lot 內的序號，cursor 分頁不用 skip。
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId
from pymongo import ASCENDING, DESCENDING, ReturnDocument, UpdateOne

from app.models.lot import Progress, SourceImage

# 清單只需要這些欄位（meta / extra 可能很大，不帶）
LIST_PROJECTION = {
    "lot": 1, "seq": 1, "image": 1, "verdict": 1, "defect_count": 1, "defects": 1, "ai": 1, "ai_cmp": 1,
}


def to_object_id(value: str) -> ObjectId | None:
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        return None


def new_annotation(img: SourceImage, now: datetime) -> dict[str, Any]:
    """開啟 Lot 時建立的空白標註（image_id 由 upsert 條件帶入，不放在這裡）。"""
    return {
        "lot": img.lot,
        "seq": img.seq,
        "image": {"path": img.path, "filename": img.filename, "width": img.width, "height": img.height},
        "meta": img.meta,
        "extra": {},
        "ai": img.ai,  # 開啟時帶入，之後不修改
        "ai_cmp": None,
        "verdict": None,  # 尚未儲存過
        "defect_count": 0,
        "defects": [],
        "version": 1,
        "created_at": now,
        "updated_by": None,
        "updated_at": None,
    }


@dataclass
class ListFilter:
    """Lot 清單的篩選條件（值都是字串，空字串 = 不篩選）。"""

    verdict: str = ""  # NG / OK / none
    class_id: str = ""  # 類別 id
    ai: str = ""  # OK / 類別 id
    ai_cmp: str = ""  # escape / overkill / mismatch

    KEYS = ("verdict", "class_id", "ai", "ai_cmp")

    def conditions(self, skip: str | None = None) -> dict[str, Any]:
        """轉成 Mongo 查詢條件；skip 指定的那個條件不套用（計算篩選選項張數用）。"""
        q: dict[str, Any] = {}
        if self.verdict and skip != "verdict":
            q["verdict"] = None if self.verdict == "none" else self.verdict
        if self.class_id != "" and skip != "class_id":
            q["defects.class_id"] = int(self.class_id)
        if self.ai and skip != "ai":
            q["ai.result"] = self.ai
        if self.ai_cmp and skip != "ai_cmp":
            q["ai_cmp"] = self.ai_cmp
        return q


class AnnotationRepo:
    def __init__(self, collection):
        self._c = collection

    async def ensure_indexes(self) -> None:
        await self._c.create_index("image_id", unique=True)
        for keys in (
            [("lot", ASCENDING), ("seq", ASCENDING)],
            [("lot", ASCENDING), ("verdict", ASCENDING), ("seq", ASCENDING)],
            [("lot", ASCENDING), ("defects.class_id", ASCENDING), ("seq", ASCENDING)],
            [("defects.class_id", ASCENDING), ("lot", ASCENDING), ("seq", ASCENDING)],  # 類別圖片清單（跨 Lot）
            [("lot", ASCENDING), ("ai.result", ASCENDING), ("seq", ASCENDING)],
            [("lot", ASCENDING), ("ai_cmp", ASCENDING), ("seq", ASCENDING)],
        ):
            await self._c.create_index(keys)

    # ---------- 開啟 Lot ----------

    async def upsert_batch(self, images: list[SourceImage]) -> None:
        """不存在才建立；已存在的（重複開啟）完全不動，不會覆蓋標註。"""
        if not images:
            return
        now = datetime.now(UTC)
        ops = [
            UpdateOne({"image_id": img.image_id}, {"$setOnInsert": new_annotation(img, now)}, upsert=True)
            for img in images
        ]
        await self._c.bulk_write(ops, ordered=False)

    async def progress(self, lot: str) -> Progress:
        counts: dict[Any, int] = {}
        cursor = await self._c.aggregate(
            [{"$match": {"lot": lot}}, {"$group": {"_id": "$verdict", "n": {"$sum": 1}}}]
        )
        async for row in cursor:
            counts[row["_id"]] = row["n"]
        ok, ng = counts.get("OK", 0), counts.get("NG", 0)
        return Progress(total=sum(counts.values()), done=ok + ng, ok=ok, ng=ng)

    async def unlabeled_ids(self, lot: str, limit: int = 0) -> AsyncIterator[str]:
        """尚未標註的 annotation id，依 seq 排序（建立待標註佇列用）。"""
        cursor = self._c.find({"lot": lot, "verdict": None}, {"_id": 1}).sort("seq", ASCENDING)
        if limit:
            cursor = cursor.limit(limit)
        async for doc in cursor:
            yield str(doc["_id"])

    async def count_unlabeled(self, lot: str) -> int:
        return await self._c.count_documents({"lot": lot, "verdict": None})

    # ---------- 單張 ----------

    async def get(self, ann_id: str) -> dict[str, Any] | None:
        oid = to_object_id(ann_id)
        return await self._c.find_one({"_id": oid}) if oid else None

    async def save(self, ann_id: str, version: int, fields: dict[str, Any]) -> dict[str, Any] | None:
        """樂觀鎖：version 相符才更新並 +1；不符（或不存在）回傳 None。"""
        oid = to_object_id(ann_id)
        if oid is None:
            return None
        return await self._c.find_one_and_update(
            {"_id": oid, "version": version},
            {"$set": fields, "$inc": {"version": 1}},
            return_document=ReturnDocument.AFTER,
        )

    # ---------- Lot 清單 ----------

    async def list_lot(self, lot: str, flt: ListFilter, after_seq: int | None, limit: int) -> list[dict]:
        q = {"lot": lot, **flt.conditions()}
        if after_seq is not None:
            q["seq"] = {"$gt": after_seq}
        return await self._c.find(q, LIST_PROJECTION).sort("seq", ASCENDING).limit(limit).to_list()

    async def count_lot(self, lot: str, flt: ListFilter) -> int:
        return await self._c.count_documents({"lot": lot, **flt.conditions()})

    async def facets(self, lot: str, flt: ListFilter) -> dict[str, dict[str, Any]]:
        """各篩選選項的張數。每一組只套用「其他」篩選條件，讓選項彼此連動。"""
        branches: dict[str, list[dict]] = {}
        for key in ListFilter.KEYS:
            match = [{"$match": flt.conditions(skip=key)}]
            branches[f"{key}_all"] = [*match, {"$count": "n"}]
            if key == "class_id":
                # 一張圖有多個同類別的框只算一張
                branches[key] = [
                    *match,
                    {"$unwind": "$defects"},
                    {"$group": {"_id": {"a": "$_id", "c": "$defects.class_id"}}},
                    {"$group": {"_id": "$_id.c", "n": {"$sum": 1}}},
                ]
            else:
                field = {"verdict": "$verdict", "ai": "$ai.result", "ai_cmp": "$ai_cmp"}[key]
                branches[key] = [*match, {"$group": {"_id": field, "n": {"$sum": 1}}}]

        cursor = await self._c.aggregate([{"$match": {"lot": lot}}, {"$facet": branches}])
        row = (await cursor.to_list())[0]
        out: dict[str, dict[str, Any]] = {}
        for key in ListFilter.KEYS:
            all_rows = row.get(f"{key}_all") or []
            counts: dict[str, int] = {}
            for r in row.get(key) or []:
                value = r["_id"]
                if value is None:
                    if key != "verdict":
                        continue  # 沒有 AI 結果 / 沒有比對結果的不列為選項
                    value = "none"
                counts[str(value)] = r["n"]
            out[key] = {"all": all_rows[0]["n"] if all_rows else 0, "counts": counts}
        return out

    async def neighbors_in_lot(self, lot: str, seq: int, flt: ListFilter) -> tuple[dict | None, dict | None, int, int]:
        """(上一張, 下一張, 目前位置, 總數)，只在 Lot 的篩選結果內。"""
        base = {"lot": lot, **flt.conditions()}
        proj = {"_id": 1, "lot": 1}
        prev = await self._c.find_one({**base, "seq": {"$lt": seq}}, proj, sort=[("seq", DESCENDING)])
        nxt = await self._c.find_one({**base, "seq": {"$gt": seq}}, proj, sort=[("seq", ASCENDING)])
        before = await self._c.count_documents({**base, "seq": {"$lt": seq}})
        total = await self._c.count_documents(base)
        return prev, nxt, before + 1, total

    # ---------- 類別圖片清單（跨全部 Lot） ----------

    @staticmethod
    def _class_query(class_id: int, lots: list[str]) -> dict[str, Any]:
        return {"defects.class_id": class_id, "lot": {"$in": lots}}

    async def list_class(
        self, class_id: int, lots: list[str], after: tuple[str, int] | None, limit: int
    ) -> list[dict]:
        q = self._class_query(class_id, lots)
        if after is not None:
            lot, seq = after
            q["$or"] = [{"lot": {"$gt": lot}}, {"lot": lot, "seq": {"$gt": seq}}]
        cursor = self._c.find(q, LIST_PROJECTION).sort([("lot", ASCENDING), ("seq", ASCENDING)]).limit(limit)
        return await cursor.to_list()

    async def count_class(self, class_id: int, lots: list[str]) -> int:
        return await self._c.count_documents(self._class_query(class_id, lots))

    async def neighbors_in_class(
        self, class_id: int, lots: list[str], lot: str, seq: int
    ) -> tuple[dict | None, dict | None, int, int]:
        base = self._class_query(class_id, lots)
        before_q = {**base, "$or": [{"lot": {"$lt": lot}}, {"lot": lot, "seq": {"$lt": seq}}]}
        after_q = {**base, "$or": [{"lot": {"$gt": lot}}, {"lot": lot, "seq": {"$gt": seq}}]}
        proj = {"_id": 1, "lot": 1}
        prev = await self._c.find_one(before_q, proj, sort=[("lot", DESCENDING), ("seq", DESCENDING)])
        nxt = await self._c.find_one(after_q, proj, sort=[("lot", ASCENDING), ("seq", ASCENDING)])
        before = await self._c.count_documents(before_q)
        total = await self._c.count_documents(base)
        return prev, nxt, before + 1, total

    # ---------- 統計（全部已開啟的 Lot） ----------

    async def stats(self, lots: list[str]) -> dict[str, Any]:
        cursor = await self._c.aggregate([
            {"$match": {"lot": {"$in": lots}}},
            {"$facet": {
                "overview": [{"$group": {"_id": "$verdict", "n": {"$sum": 1}, "boxes": {"$sum": "$defect_count"}}}],
                "classes": [
                    {"$match": {"defect_count": {"$gt": 0}}},
                    {"$unwind": "$defects"},
                    {"$group": {"_id": {"c": "$defects.class_id", "a": "$_id"}, "boxes": {"$sum": 1}}},
                    {"$group": {"_id": "$_id.c", "boxes": {"$sum": "$boxes"}, "images": {"$sum": 1}}},
                ],
            }},
        ])
        rows = await cursor.to_list()
        return rows[0] if rows else {"overview": [], "classes": []}
