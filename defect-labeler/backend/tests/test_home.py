"""主頁後端：身分與權限、Lot 格式、查詢（cache-aside）、開啟 Lot。"""

import json
from datetime import UTC, datetime, timedelta

from tests.conftest import LOT, NEW_LOT, open_lot as open_and_wait


# ---------- 身分與權限 ----------


async def test_me(client):
    r = await client.get("/me")
    assert r.status_code == 200
    assert r.json() == {"id": "weichun", "name": "weichun", "role": "editor",
                        "permissions": ["view", "open_lot", "annotate"]}


async def test_unknown_or_inactive_user_is_401(client):
    assert (await client.get("/me", headers={"X-User-Id": "nobody"})).status_code == 401
    assert (await client.get("/me", headers={"X-User-Id": "frank"})).status_code == 401  # active: false
    assert (await client.get("/me", headers={"X-User-Id": ""})).status_code == 401


async def test_viewer_can_lookup_but_not_open(client):
    viewer = {"X-User-Id": "eric"}
    assert (await client.get(f"/lots/{NEW_LOT}", headers=viewer)).status_code == 200
    assert (await client.post(f"/lots/{NEW_LOT}/open", headers=viewer)).status_code == 403


# ---------- Lot 格式 ----------


async def test_lot_format(client):
    r = await client.get("/lots/2026-01-03")
    assert r.status_code == 422
    assert "格式不正確" in r.json()["detail"]
    # 小寫自動轉大寫
    assert (await client.get("/lots/abcdef-01-03")).status_code == 404


async def test_lot_not_found(client):
    r = await client.get("/lots/ZZZZZZ-99-99")
    assert r.status_code == 404
    assert "找不到" in r.json()["detail"]
    assert (await client.post("/lots/ZZZZZZ-99-99/open")).status_code == 404


# ---------- 查詢：cache-aside ----------


async def test_lookup_miss_reads_mongo_then_fills_cache(client, env):
    r = await client.get(f"/lots/{NEW_LOT}")
    body = r.json()
    assert r.status_code == 200
    assert body["status"] == "new"
    assert body["image_count"] == 30
    assert body["meta"] == {"product": "PCB-A12", "station": "AOI-05"}
    assert body["data_source"] == "mongo"

    await env.tasks.wait_all()  # 背景回填
    meta = json.loads(await env.redis.get(f"{NEW_LOT}:meta"))
    assert meta["complete"] is True and meta["count"] == 30
    assert await env.redis.hlen(f"{NEW_LOT}:images") == 30
    order = await env.redis.lrange(f"{NEW_LOT}:order", 0, -1)
    assert order[0] == f"{NEW_LOT}-00000" and len(order) == 30
    cached = json.loads(await env.redis.hget(f"{NEW_LOT}:images", order[0]))
    assert cached["captured_at"] == "2026-11-01T00:00:00+00:00"  # ISODate → ISO 8601

    r = await client.get(f"/lots/{NEW_LOT}")
    assert r.json()["data_source"] == "redis"
    assert r.json()["meta"] == {"product": "PCB-A12", "station": "AOI-05"}


async def test_incomplete_cache_is_a_miss(client, env):
    await env.redis.set(f"{NEW_LOT}:meta", json.dumps({"count": 30, "complete": False}))
    assert (await client.get(f"/lots/{NEW_LOT}")).json()["data_source"] == "mongo"


async def test_fill_lock_prevents_concurrent_fill(env):
    await env.redis.set(f"dl:fill:{NEW_LOT}", "someone-else")
    assert await env.c.source.fill_cache(NEW_LOT) is False
    assert await env.redis.get(f"{NEW_LOT}:meta") is None


async def test_redis_down_degrades_to_mongo(client, env):
    broken = _BrokenRedis()
    env.c.source._redis = broken
    env.c.presence._r = broken
    r = await client.get(f"/lots/{NEW_LOT}")
    assert r.status_code == 200
    assert r.json()["data_source"] == "mongo"
    await env.tasks.wait_all()


class _BrokenRedis:
    """所有指令都丟連線錯誤。"""

    def __getattr__(self, name):
        from redis.exceptions import ConnectionError

        async def fail(*a, **k):
            raise ConnectionError("redis down")

        return fail


# ---------- 開啟 Lot ----------


async def test_open_lot_creates_annotations_and_queue(client, env):
    r = await open_and_wait(client, env)
    assert r.status_code == 202
    assert r.json()["status"] == "initializing"

    assert env.ann.count_documents({"lot": LOT}) == 2500
    ann = env.ann.find_one({"image_id": f"{LOT}-00000"})
    assert ann["verdict"] is None and ann["defects"] == [] and ann["version"] == 1
    assert ann["image"] == {"path": f"/data/{LOT}/P00000.png", "filename": "P00000.png", "width": 300, "height": 300}
    assert ann["meta"] == {"product": "PCB-A12", "station": "AOI-03"}
    assert ann["seq"] == 1
    assert ann["ai"] == {"result": "0", "score": 0.9, "model": None}

    assert await env.redis.llen(f"dl:queue:{LOT}") == 2500

    body = (await client.get(f"/lots/{LOT}")).json()
    assert body["status"] == "open"
    assert body["data_source"] == "annotations"
    assert body["progress"] == {"total": 2500, "done": 0, "ok": 0, "ng": 0}
    assert body["online"] == 0


async def test_open_reports_progress(client, env):
    await open_and_wait(client, env)
    lot = env.lots.find_one({"lot": LOT})
    assert lot["status"] == "open" and lot["init_done"] == 2500 and lot["opened_by"] == "weichun"


async def test_open_twice_is_idempotent_and_keeps_labels(client, env):
    await open_and_wait(client, env)
    # 模擬已經標註過一張
    env.ann.update_one({"image_id": f"{LOT}-00001"},
                                  {"$set": {"verdict": "NG", "defect_count": 1, "defects": [{"class_id": 0}]}})
    r = await open_and_wait(client, env)
    assert r.status_code == 200 and r.json()["status"] == "open"
    assert env.ann.count_documents({"lot": LOT}) == 2500
    assert (env.ann.find_one({"image_id": f"{LOT}-00001"}))["verdict"] == "NG"
    body = (await client.get(f"/lots/{LOT}")).json()
    assert body["progress"] == {"total": 2500, "done": 1, "ok": 0, "ng": 1}


async def test_open_uses_redis_cache_when_complete(client, env):
    await client.get(f"/lots/{LOT}")
    await env.tasks.wait_all()  # 快取已回填
    env.source_coll.sync.delete_many({})  # 之後若還讀 Mongo 就會讀不到
    await open_and_wait(client, env)
    assert env.ann.count_documents({"lot": LOT}) == 2500


async def test_concurrent_open_starts_once(client, env):
    import asyncio

    r1, r2 = await asyncio.gather(client.post(f"/lots/{LOT}/open"), client.post(f"/lots/{LOT}/open"))
    await env.tasks.wait_all()
    assert {r1.status_code, r2.status_code} <= {200, 202}
    assert env.lots.count_documents({}) == 1
    assert env.ann.count_documents({"lot": LOT}) == 2500


async def test_failed_open_can_retry(client, env):
    original = env.c.lot_service.annotations.upsert_batch
    calls = 0

    async def flaky(batch):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("mongo write error")
        await original(batch)

    env.c.lot_service.annotations.upsert_batch = flaky
    await open_and_wait(client, env)
    body = (await client.get(f"/lots/{LOT}")).json()
    assert body["status"] == "failed" and "mongo write error" in body["error"]

    r = await open_and_wait(client, env)
    assert r.json()["status"] == "initializing"
    assert (await client.get(f"/lots/{LOT}")).json()["status"] == "open"
    assert env.ann.count_documents({"lot": LOT}) == 2500


async def test_stale_initializing_is_reported_failed_and_reopenable(client, env):
    old = datetime.now(UTC) - timedelta(minutes=10)
    env.lots.insert_one({"lot": LOT, "status": "initializing", "image_count": 2500,
                               "init_done": 1000, "meta": {}, "heartbeat_at": old})
    body = (await client.get(f"/lots/{LOT}")).json()
    assert body["status"] == "failed" and body["init"] == {"done": 1000, "total": 2500}

    await open_and_wait(client, env)
    assert (await client.get(f"/lots/{LOT}")).json()["status"] == "open"


async def test_initializing_in_progress_is_not_restarted(client, env):
    env.lots.insert_one({"lot": LOT, "status": "initializing", "image_count": 2500,
                               "init_done": 1000, "meta": {}, "heartbeat_at": datetime.now(UTC)})
    r = await open_and_wait(client, env)
    assert r.json()["status"] == "initializing"
    assert env.ann.count_documents({}) == 0


async def test_online_count(client, env):
    await open_and_wait(client, env)
    await env.c.presence.touch(LOT, "amy")
    await env.c.presence.touch(LOT, "ben")
    assert (await client.get(f"/lots/{LOT}")).json()["online"] == 2
