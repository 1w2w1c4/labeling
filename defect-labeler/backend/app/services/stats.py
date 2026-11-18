"""缺點分布統計（全部已開啟的 Lot），結果快取在 dl:stats（TTL 60 秒，儲存標註時刪除）。"""

import logging
from datetime import UTC, datetime

import redis.asyncio as aioredis

from app.core.cache import REDIS_ERRORS, dumps, loads
from app.models.annotation import ClassStat, StatsOut
from app.models.defect_class import ClassCatalog
from app.repositories.annotation import AnnotationRepo
from app.repositories.lot import LotRepo

log = logging.getLogger(__name__)

STATS_KEY = "dl:stats"


class StatsService:
    def __init__(
        self, annotations: AnnotationRepo, lots: LotRepo, classes: ClassCatalog, redis: aioredis.Redis, ttl: int
    ):
        self._anns = annotations
        self._lots = lots
        self._classes = classes
        self._r = redis
        self._ttl = ttl

    async def get(self, refresh: bool = False) -> StatsOut:
        if not refresh:
            try:
                raw = await self._r.get(STATS_KEY)
                if raw:
                    return StatsOut.model_validate(loads(raw))
            except REDIS_ERRORS as e:
                log.warning("讀取統計快取失敗：%s", e)
            except ValueError:
                pass  # 快取格式不對（例如舊版本），重新計算

        stats = await self._compute()
        try:
            await self._r.set(STATS_KEY, dumps(stats.model_dump(mode="json")), ex=self._ttl)
        except REDIS_ERRORS as e:
            log.warning("寫入統計快取失敗：%s", e)
        return stats

    async def invalidate(self) -> None:
        try:
            await self._r.delete(STATS_KEY)
        except REDIS_ERRORS as e:
            log.warning("刪除統計快取失敗：%s", e)

    async def _compute(self) -> StatsOut:
        lots = await self._lots.open_lots()
        raw = await self._anns.stats(lots)
        by_verdict = {r["_id"]: r for r in raw.get("overview") or []}
        ng = by_verdict.get("NG", {}).get("n", 0)
        ok = by_verdict.get("OK", {}).get("n", 0)
        images = sum(r["n"] for r in by_verdict.values())
        boxes = sum(r.get("boxes", 0) for r in by_verdict.values())
        per_class = {r["_id"]: r for r in raw.get("classes") or []}
        return StatsOut(
            images=images,
            labeled=ng + ok,
            ng=ng,
            ok=ok,
            unlabeled=images - ng - ok,
            boxes=boxes,
            avg_boxes_per_ng=round(boxes / ng, 2) if ng else 0.0,
            lots=len(lots),
            # 所有類別都列出（沒有框的為 0），依 id 排序；前端再依框數／圖片數排序
            classes=[
                ClassStat(
                    class_id=c.id,
                    boxes=per_class.get(c.id, {}).get("boxes", 0),
                    images=per_class.get(c.id, {}).get("images", 0),
                )
                for c in self._classes.all()
            ],
            cached_at=datetime.now(UTC),
        )
