"""主頁的 Lot 查詢與開啟。

開啟流程：try_start（搶開啟權）→ 背景逐批 upsert annotations（每批 1000）
→ 狀態 open → 重建待標註佇列 dl:queue:{lot}。
"""

import logging
from datetime import UTC, datetime, timedelta

from app.core.cache import REDIS_ERRORS
from app.core.config import Settings
from app.core.tasks import TaskRunner
from app.models.lot import InitProgress, LotInfo, LotRecord
from app.repositories.annotation import AnnotationRepo
from app.repositories.lot import LotRepo
from app.repositories.lot_source import LotSource
from app.services.presence import Presence
from app.services.queue import AnnotationQueue

log = logging.getLogger(__name__)


class LotNotFound(Exception):
    pass


class LotService:
    def __init__(
        self,
        source: LotSource,
        lots: LotRepo,
        annotations: AnnotationRepo,
        queue: AnnotationQueue,
        presence: Presence,
        tasks: TaskRunner,
        settings: Settings,
        on_opened=None,  # 開啟完成後呼叫（刪除統計快取）
    ):
        self.source = source
        self.lots = lots
        self.annotations = annotations
        self.queue = queue
        self.presence = presence
        self.tasks = tasks
        self.settings = settings
        self.on_opened = on_opened

    # ---------- 查詢 ----------

    def _is_stale(self, rec: LotRecord) -> bool:
        if rec.status != "initializing" or rec.heartbeat_at is None:
            return False
        limit = timedelta(seconds=self.settings.init_stale_seconds)
        return datetime.now(UTC) - rec.heartbeat_at > limit

    async def info(self, lot: str) -> LotInfo:
        rec = await self.lots.get(lot)

        if rec is not None and rec.status == "open":
            return LotInfo(
                lot=lot,
                status="open",
                image_count=rec.image_count,
                meta=rec.meta,
                data_source="annotations",
                progress=await self.annotations.progress(lot),
                online=await self.presence.count(lot),
            )

        if rec is not None and rec.status == "initializing":
            stale = self._is_stale(rec)
            return LotInfo(
                lot=lot,
                status="failed" if stale else "initializing",
                image_count=rec.image_count,
                meta=rec.meta,
                data_source="annotations",
                init=InitProgress(done=rec.init_done, total=rec.image_count),
                error="初始化中斷，請重新開啟" if stale else None,
            )

        # 尚未開啟，或上次開啟失敗：查來源
        summary = await self.source.summary(lot)
        if summary is None:
            raise LotNotFound(lot)
        return LotInfo(
            lot=lot,
            status="failed" if rec is not None else "new",
            image_count=summary.count,
            meta=summary.meta,
            data_source=summary.data_source,
            error=rec.error if rec is not None else None,
        )

    # ---------- 開啟 ----------

    async def open(self, lot: str, user_id: str) -> LotInfo:
        """開始開啟 Lot（背景執行），立刻回傳目前狀態。已開啟或開啟中時不重複執行。"""
        rec = await self.lots.get(lot)
        if rec is None or rec.status == "failed" or self._is_stale(rec):
            summary = await self.source.summary(lot)
            if summary is None:
                raise LotNotFound(lot)
            started, _ = await self.lots.try_start(
                lot, summary.count, summary.meta, user_id, self.settings.init_stale_seconds
            )
            if started:
                log.info("%s 開啟 Lot %s（%d 張）", user_id, lot, summary.count)
                self.tasks.spawn(self._initialize(lot), name=f"open-lot:{lot}")
        return await self.info(lot)

    async def _initialize(self, lot: str) -> None:
        try:
            done = 0
            async for batch in self.source.iter_batches(lot, self.settings.init_batch_size):
                for i, img in enumerate(batch, start=done + 1):
                    img.seq = i  # Lot 內序號，依來源順序
                await self.annotations.upsert_batch(batch)
                done += len(batch)
                await self.lots.report_progress(lot, done)
            if done == 0:
                raise RuntimeError("來源資料沒有任何圖片")
            await self.lots.mark_open(lot, done)
            if self.on_opened is not None:
                await self.on_opened()
        except Exception as e:
            log.exception("開啟 Lot %s 失敗", lot)
            await self.lots.mark_failed(lot, f"開啟失敗：{e}")
            return

        # 佇列失敗不影響開啟結果（之後可以重建）
        try:
            ids = [i async for i in self.annotations.unlabeled_ids(lot)]
            await self.queue.rebuild(lot, ids)
        except REDIS_ERRORS as e:
            log.warning("建立 Lot %s 的待標註佇列失敗：%s", lot, e)
