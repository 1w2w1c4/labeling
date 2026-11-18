"""既有的圖片資料來源：先讀 Redis，找不到才查 Mongo（cache-aside）。

Redis 結構（一個 Lot 三個 key，前綴由 source.yaml 的 redis_key 決定）：
  {lot}:meta    string  {"schema_version":1,"count":N,"cached_at":...,"complete":true,"summary":{...}}，最後寫入
  {lot}:images  hash    image_id → 原始文件 JSON（與 Mongo 相同格式）
  {lot}:order   list    image_id 的順序

注意：既有 Redis 的實際格式還沒確認，拿到後只需要改這個檔案的讀取部分。
"""

import logging
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Any

import redis.asyncio as aioredis

from app.core.cache import RELEASE_LOCK_LUA, REDIS_ERRORS, dumps, fill_lock_key, loads
from app.core.config import SourceConfig
from app.models.lot import SourceImage, SourceSummary

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
CACHE_BATCH = 1000


class CacheIncomplete(Exception):
    """快取內容和 meta 記錄的數量不一致。"""


def get_path(doc: dict[str, Any], dotted: str | None) -> Any:
    """依點號路徑取巢狀欄位，例如 info.lot。"""
    if not dotted:
        return None
    cur: Any = doc
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


class LotSource:
    def __init__(
        self,
        collection,  # 來源圖片的 AsyncCollection
        redis: aioredis.Redis,
        config: SourceConfig,
        spawn: Callable[..., Any],
    ):
        self._coll = collection
        self._redis = redis
        self._cfg = config
        self._spawn = spawn
        self._release = redis.register_script(RELEASE_LOCK_LUA)

    # ---------- 欄位對應 ----------

    def _key(self, lot: str, part: str) -> str:
        return f"{self._cfg.redis_key.format(lot=lot)}:{part}"

    def _query(self, lot: str) -> dict[str, Any]:
        return {self._cfg.fields.lot: lot}

    def image_id_of(self, doc: dict[str, Any]) -> str:
        return str(get_path(doc, self._cfg.fields.id))

    def meta_of(self, doc: dict[str, Any]) -> dict[str, Any]:
        return {k: get_path(doc, src) for k, src in self._cfg.meta.items()}

    def normalize(self, doc: dict[str, Any], lot: str) -> SourceImage:
        f = self._cfg.fields
        path = str(get_path(doc, f.path) or "")
        filename = get_path(doc, f.filename) if f.filename else None
        ai = {k: get_path(doc, src) for k, src in self._cfg.ai.items()}
        if ai.get("result") is not None:
            ai["result"] = str(ai["result"])  # "OK" 或類別 id，統一存成字串方便篩選
        return SourceImage(
            image_id=self.image_id_of(doc),
            lot=lot,
            path=path,
            # 路徑可能是 Windows 格式，先統一成 /
            filename=str(filename or PurePosixPath(path.replace("\\", "/")).name),
            width=int(get_path(doc, f.width) or self._cfg.default_width),
            height=int(get_path(doc, f.height) or self._cfg.default_height),
            meta=self.meta_of(doc),
            ai=ai if any(v is not None for v in ai.values()) else None,
        )

    # ---------- 查詢摘要（主頁用） ----------

    async def summary(self, lot: str) -> SourceSummary | None:
        """Lot 的圖片數量與 meta；來源沒有這個 Lot 回傳 None。"""
        envelope = await self._read_meta(lot)
        if envelope is not None:
            return SourceSummary(
                count=int(envelope["count"]), meta=envelope.get("summary") or {}, data_source="redis"
            )

        count = await self._coll.count_documents(self._query(lot))
        if count == 0:
            return None
        first = await self._coll.find_one(self._query(lot), sort=[(self._cfg.fields.id, 1)])
        # 回填快取放背景做，不讓查詢等上萬筆寫入
        self._spawn(self.fill_cache(lot), name=f"fill-cache:{lot}")
        return SourceSummary(count=count, meta=self.meta_of(first) if first else {}, data_source="mongo")

    async def _read_meta(self, lot: str) -> dict[str, Any] | None:
        """快取有效時回傳 meta envelope；不存在、未完成或 Redis 故障都視為未命中。"""
        try:
            raw = await self._redis.get(self._key(lot, "meta"))
        except REDIS_ERRORS as e:
            log.warning("讀取 Redis 失敗，改查 Mongo：%s", e)
            return None
        if not raw:
            return None
        try:
            envelope = loads(raw)
        except ValueError:
            return None
        if not isinstance(envelope, dict) or envelope.get("complete") is not True or "count" not in envelope:
            return None
        return envelope

    # ---------- 回填快取 ----------

    async def fill_cache(self, lot: str) -> bool:
        """從 Mongo 讀整個 Lot 寫進 Redis。用 dl:fill:{lot} 鎖防止多個請求同時回填。"""
        lock = fill_lock_key(lot)
        token = uuid.uuid4().hex
        try:
            if not await self._redis.set(lock, token, nx=True, ex=self._cfg.fill_lock_ttl):
                return False  # 別人正在回填
        except REDIS_ERRORS as e:
            log.warning("Redis 無法使用，略過回填快取：%s", e)
            return False

        meta_key, images_key, order_key = (self._key(lot, p) for p in ("meta", "images", "order"))
        try:
            # 先刪 meta，讓讀取端在回填期間一律視為未命中
            await self._redis.delete(meta_key, images_key, order_key)
            count = 0
            first: dict[str, Any] | None = None
            batch: list[tuple[str, str]] = []

            async def flush() -> None:
                async with self._redis.pipeline(transaction=False) as p:
                    p.hset(images_key, mapping=dict(batch))
                    p.rpush(order_key, *(iid for iid, _ in batch))
                    await p.execute()
                batch.clear()

            async for doc in self._coll.find(self._query(lot)).sort(self._cfg.fields.id, 1):
                first = first or doc
                batch.append((self.image_id_of(doc), dumps(doc)))
                count += 1
                if len(batch) >= CACHE_BATCH:
                    await flush()
            if batch:
                await flush()
            if count == 0:
                return False

            envelope = {
                "schema_version": SCHEMA_VERSION,
                "count": count,
                "cached_at": datetime.now(UTC).isoformat(),
                "complete": True,
                "summary": self.meta_of(first) if first else {},
            }
            ttl = self._cfg.redis_ttl
            async with self._redis.pipeline(transaction=False) as p:
                p.expire(images_key, ttl)
                p.expire(order_key, ttl)
                p.set(meta_key, dumps(envelope), ex=ttl)  # meta 最後寫入
                await p.execute()
            return True
        except REDIS_ERRORS as e:
            log.warning("回填快取失敗（Lot %s）：%s", lot, e)
            return False
        finally:
            try:
                await self._release(keys=[lock], args=[token])
            except REDIS_ERRORS:
                pass  # 鎖有 TTL，會自己過期

    # ---------- 逐批讀取（開啟 Lot 用） ----------

    async def iter_batches(self, lot: str, size: int) -> AsyncIterator[list[SourceImage]]:
        """依序讀出整個 Lot。快取完整就讀 Redis，否則讀 Mongo。"""
        envelope = await self._read_meta(lot)
        if envelope is not None:
            try:
                count = int(envelope["count"])
                async for batch in self._iter_cache(lot, count, size):
                    yield batch
                return
            except CacheIncomplete:
                # 只會發生在開始讀之前（_iter_cache 先檢查數量），不會重複輸出
                log.warning("Lot %s 的快取不完整，改讀 Mongo", lot)
            except REDIS_ERRORS as e:
                raise RuntimeError(f"讀取 Redis 快取時中斷：{e}") from e

        batch: list[SourceImage] = []
        async for doc in self._coll.find(self._query(lot)).sort(self._cfg.fields.id, 1):
            batch.append(self.normalize(doc, lot))
            if len(batch) >= size:
                yield batch
                batch = []
        if batch:
            yield batch

    async def _iter_cache(self, lot: str, count: int, size: int) -> AsyncIterator[list[SourceImage]]:
        images_key, order_key = self._key(lot, "images"), self._key(lot, "order")
        try:
            hlen, llen = await self._redis.hlen(images_key), await self._redis.llen(order_key)
        except REDIS_ERRORS as e:
            raise CacheIncomplete() from e
        if hlen != count or llen != count:
            raise CacheIncomplete()
        for start in range(0, count, size):
            ids = await self._redis.lrange(order_key, start, start + size - 1)
            raws = await self._redis.hmget(images_key, ids)
            if any(r is None for r in raws):
                raise RuntimeError(f"Lot {lot} 的快取在讀取途中被修改或過期，請重新開啟")
            yield [self.normalize(loads(r), lot) for r in raws]
