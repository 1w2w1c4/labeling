"""線上人數：dl:online:{lot} 是 sorted set，member = 使用者 id，score = 最後心跳時間（秒）。

心跳由標註頁送出（M2 實作），這裡先提供寫入與計數。
"""

import logging
import time

import redis.asyncio as aioredis

from app.core.cache import REDIS_ERRORS, online_key

log = logging.getLogger(__name__)


class Presence:
    def __init__(self, redis: aioredis.Redis, window_seconds: int):
        self._r = redis
        self._window = window_seconds

    async def touch(self, lot: str, user_id: str) -> None:
        key, now = online_key(lot), time.time()
        try:
            async with self._r.pipeline(transaction=False) as p:
                p.zadd(key, {user_id: now})
                p.zremrangebyscore(key, "-inf", now - self._window)
                p.expire(key, self._window * 2)
                await p.execute()
        except REDIS_ERRORS as e:
            log.warning("更新線上狀態失敗：%s", e)

    async def count(self, lot: str) -> int:
        try:
            return await self._r.zcount(online_key(lot), time.time() - self._window, "+inf")
        except REDIS_ERRORS as e:
            log.warning("讀取線上人數失敗：%s", e)
            return 0
