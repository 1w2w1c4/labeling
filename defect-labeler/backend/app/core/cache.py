"""Redis 連線與共用工具。

Redis 只是快取：任何 Redis 錯誤都要降級（改讀 Mongo / 略過），不能讓 API 失敗。
"""

import json
from datetime import date, datetime
from typing import Any

import redis.asyncio as aioredis
from bson import ObjectId
from redis.exceptions import RedisError

# 呼叫端用 except REDIS_ERRORS 降級（連線失敗有時會以 OSError 形式出現）
REDIS_ERRORS = (RedisError, OSError)

# 只有持有者才能釋放的鎖（值相同才刪除）
RELEASE_LOCK_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


def create_redis(url: str) -> aioredis.Redis:
    return aioredis.from_url(url, decode_responses=True, socket_timeout=3, socket_connect_timeout=3)


def _json_default(o: Any) -> Any:
    if isinstance(o, ObjectId):
        return str(o)
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    return str(o)  # Decimal128 等其他 BSON 型別


def dumps(doc: Any) -> str:
    """Mongo 文件轉 JSON：ObjectId → 字串、ISODate → ISO 8601，其餘欄位格式不變。"""
    return json.dumps(doc, default=_json_default, ensure_ascii=False, separators=(",", ":"))


def loads(s: str) -> Any:
    return json.loads(s)


# ---------- 我們自己的 key（前綴 dl:） ----------


def fill_lock_key(lot: str) -> str:
    return f"dl:fill:{lot}"


def queue_key(lot: str) -> str:
    return f"dl:queue:{lot}"


def online_key(lot: str) -> str:
    return f"dl:online:{lot}"
