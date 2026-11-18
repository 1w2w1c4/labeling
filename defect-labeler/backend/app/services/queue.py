"""待標註佇列 dl:queue:{lot}：尚未標註的 annotation id。

「開始標註」與佇列模式的「下一張」：LPOP 取出 → 確認仍未標註 → 搶編輯鎖，搶到才給這個人。
被別人鎖住的直接丟掉；佇列空了就從 Mongo 重新掃一次未標註的圖並重建（別人鎖住但沒存的圖會在這時回來）。
Redis 無法使用時直接從 Mongo 找第一張未標註的圖。
"""

import logging

import redis.asyncio as aioredis

from app.core.cache import REDIS_ERRORS, queue_key
from app.repositories.annotation import AnnotationRepo
from app.services.locking import LockService

log = logging.getLogger(__name__)

BATCH = 1000
MAX_POPS = 200  # 一次請求最多嘗試幾個 id，避免佇列裡全是無效 id 時卡太久
FALLBACK_SCAN = 500


class AnnotationQueue:
    def __init__(self, redis: aioredis.Redis):
        self._r = redis

    async def rebuild(self, lot: str, ids: list[str]) -> None:
        """整個重建。先寫到暫存 key 再 RENAME，避免讀到一半的佇列。"""
        key = queue_key(lot)
        if not ids:
            await self._r.delete(key)
            return
        tmp = f"{key}:building"
        await self._r.delete(tmp)
        for i in range(0, len(ids), BATCH):
            await self._r.rpush(tmp, *ids[i : i + BATCH])
        await self._r.rename(tmp, key)

    async def next(
        self, lot: str, user_id: str, annotations: AnnotationRepo, locks: LockService, exclude: str | None = None
    ) -> str | None:
        """下一張待標註的圖（已替 user_id 取得編輯鎖）。沒有了回傳 None。"""
        key = queue_key(lot)
        try:
            for _ in range(MAX_POPS):
                ann_id = await self._r.lpop(key)
                if ann_id is None:
                    break
                if ann_id == exclude:
                    continue
                if await self._claim(ann_id, user_id, annotations, locks):
                    return ann_id
        except REDIS_ERRORS as e:
            log.warning("讀取待標註佇列失敗，改查 Mongo：%s", e)

        # 佇列空了（或 Redis 故障）：從 Mongo 找，並重建佇列
        ids = [i async for i in annotations.unlabeled_ids(lot)]
        holders = await locks.holders(ids[:FALLBACK_SCAN])
        picked = None
        for ann_id in ids[:FALLBACK_SCAN]:
            if ann_id == exclude or holders.get(ann_id, user_id) != user_id:
                continue
            if await locks.try_lock(ann_id, user_id):
                picked = ann_id
                break
        try:
            await self.rebuild(lot, [i for i in ids if i != picked and i not in holders])
        except REDIS_ERRORS:
            pass
        return picked

    @staticmethod
    async def _claim(ann_id: str, user_id: str, annotations: AnnotationRepo, locks: LockService) -> bool:
        doc = await annotations.get(ann_id)
        if doc is None or doc.get("verdict") is not None:
            return False  # 已經被標註
        return await locks.try_lock(ann_id, user_id)
