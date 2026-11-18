"""編輯鎖 dl:lock:ann:{id}：值 = 使用者 id，SET NX EX。續約與釋放用 Lua，只有持有者能操作。

Redis 無法使用時降級：不擋編輯（回傳 degraded），只靠 Mongo 的 version 檢查避免覆蓋別人的修改。
"""

import logging

import redis.asyncio as aioredis

from app.core.cache import RELEASE_LOCK_LUA, REDIS_ERRORS

log = logging.getLogger(__name__)

RENEW_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
"""


def lock_key(ann_id: str) -> str:
    return f"dl:lock:ann:{ann_id}"


class LockResult:
    def __init__(self, held: bool, holder: str | None, ttl: int | None, degraded: bool = False):
        self.held = held
        self.holder = holder
        self.ttl = ttl
        self.degraded = degraded


class LockService:
    def __init__(self, redis: aioredis.Redis, ttl: int):
        self._r = redis
        self._ttl = ttl
        self._renew = redis.register_script(RENEW_LUA)
        self._release = redis.register_script(RELEASE_LOCK_LUA)

    async def _state(self, key: str, user_id: str) -> LockResult:
        holder = await self._r.get(key)
        ttl = await self._r.ttl(key) if holder else None
        return LockResult(held=holder == user_id, holder=holder, ttl=ttl if ttl and ttl > 0 else None)

    async def acquire(self, ann_id: str, user_id: str) -> LockResult:
        """取得鎖；自己已持有就續約。"""
        key = lock_key(ann_id)
        try:
            if await self._r.set(key, user_id, nx=True, ex=self._ttl):
                return LockResult(True, user_id, self._ttl)
            if await self._renew(keys=[key], args=[user_id, self._ttl]):
                return LockResult(True, user_id, self._ttl)
            return await self._state(key, user_id)
        except REDIS_ERRORS as e:
            log.warning("Redis 無法使用，編輯鎖降級：%s", e)
            return LockResult(True, None, None, degraded=True)

    async def renew(self, ann_id: str, user_id: str) -> LockResult:
        """續約；鎖已過期且沒人拿走時重新取得。被別人拿走則回傳 held=False。"""
        return await self.acquire(ann_id, user_id)

    async def release(self, ann_id: str, user_id: str) -> LockResult:
        key = lock_key(ann_id)
        try:
            await self._release(keys=[key], args=[user_id])
            return await self._state(key, user_id)
        except REDIS_ERRORS as e:
            log.warning("釋放編輯鎖失敗：%s", e)
            return LockResult(False, None, None, degraded=True)

    async def status(self, ann_id: str, user_id: str) -> LockResult:
        try:
            return await self._state(lock_key(ann_id), user_id)
        except REDIS_ERRORS:
            return LockResult(False, None, None, degraded=True)

    async def holder(self, ann_id: str) -> str | None:
        try:
            return await self._r.get(lock_key(ann_id))
        except REDIS_ERRORS:
            return None

    async def holders(self, ann_ids: list[str]) -> dict[str, str]:
        """多張圖的鎖持有者（清單圖格顯示「誰正在編輯」）。"""
        if not ann_ids:
            return {}
        try:
            values = await self._r.mget([lock_key(i) for i in ann_ids])
        except REDIS_ERRORS:
            return {}
        return {i: v for i, v in zip(ann_ids, values, strict=True) if v}

    async def try_lock(self, ann_id: str, user_id: str) -> bool:
        """佇列用：搶到才回傳 True（自己已持有也算）。"""
        return (await self.acquire(ann_id, user_id)).held
