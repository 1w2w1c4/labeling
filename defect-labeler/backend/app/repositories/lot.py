"""lots collection：每個開啟過的 Lot 一筆，記錄開啟狀態與初始化進度。"""

from datetime import UTC, datetime, timedelta
from typing import Any

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.models.lot import LotRecord


def _now() -> datetime:
    return datetime.now(UTC)


class LotRepo:
    def __init__(self, collection):
        self._c = collection

    async def ensure_indexes(self) -> None:
        await self._c.create_index("lot", unique=True)

    async def open_lots(self) -> list[str]:
        """所有已開啟的 Lot（統計與類別圖片清單的範圍）。"""
        return [d["lot"] async for d in self._c.find({"status": "open"}, {"_id": 0, "lot": 1})]

    async def get(self, lot: str) -> LotRecord | None:
        doc = await self._c.find_one({"lot": lot}, {"_id": 0})
        return LotRecord.model_validate(doc) if doc else None

    async def try_start(
        self, lot: str, image_count: int, meta: dict[str, Any], user_id: str, stale_seconds: int
    ) -> tuple[bool, LotRecord]:
        """搶到開啟權才回傳 True。

        可以開始的情況：沒有紀錄、上次失敗、上次初始化中斷（超過 stale_seconds 沒有進度）。
        已開啟或正在初始化時，upsert 會撞到 lot 的 unique index，回傳 False 和目前狀態。
        """
        now = _now()
        try:
            doc = await self._c.find_one_and_update(
                {
                    "lot": lot,
                    "$or": [
                        {"status": "failed"},
                        {"status": "initializing", "heartbeat_at": {"$lt": now - timedelta(seconds=stale_seconds)}},
                    ],
                },
                {
                    "$set": {
                        "status": "initializing",
                        "image_count": image_count,
                        "init_done": 0,
                        "meta": meta,
                        "error": None,
                        "opened_by": user_id,
                        "heartbeat_at": now,
                    },
                    "$setOnInsert": {"created_at": now, "extra": {}},
                },
                projection={"_id": 0},
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
            return True, LotRecord.model_validate(doc)
        except DuplicateKeyError:
            current = await self.get(lot)
            if current is None:  # 剛好被刪掉，極少見；讓呼叫端重試
                raise
            return False, current

    async def report_progress(self, lot: str, done: int) -> None:
        await self._c.update_one({"lot": lot}, {"$set": {"init_done": done, "heartbeat_at": _now()}})

    async def mark_open(self, lot: str, image_count: int) -> None:
        now = _now()
        await self._c.update_one(
            {"lot": lot},
            {"$set": {"status": "open", "image_count": image_count, "init_done": image_count,
                      "opened_at": now, "heartbeat_at": now, "error": None}},
        )

    async def mark_failed(self, lot: str, error: str) -> None:
        await self._c.update_one({"lot": lot}, {"$set": {"status": "failed", "error": error, "heartbeat_at": _now()}})
