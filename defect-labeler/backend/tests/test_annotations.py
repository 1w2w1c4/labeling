"""標註頁、Lot 清單、篩選、上一張／下一張、編輯鎖、佇列、統計、類別圖片清單。"""

import pytest

from tests.conftest import LOT, NEW_LOT, make_client, open_lot

BOX = {"x": 10, "y": 20, "w": 30, "h": 40}


@pytest.fixture
async def opened(client, env):
    await open_lot(client, env)
    return client


async def first_ids(client, n=3, **params):
    page = (await client.get(f"/lots/{LOT}/annotations", params={"limit": n, **params})).json()
    return [it["id"] for it in page["items"]]


async def save(client, ann_id, defects, version=None):
    if version is None:
        version = (await client.get(f"/annotations/{ann_id}")).json()["version"]
    return await client.put(f"/annotations/{ann_id}", json={"version": version, "defects": defects})


# ---------- 清單 ----------


async def test_list_pagination_by_seq(opened):
    page1 = (await opened.get(f"/lots/{LOT}/annotations", params={"limit": 100})).json()
    assert page1["total"] == 2500
    assert [it["seq"] for it in page1["items"]] == list(range(1, 101))
    item = page1["items"][0]
    assert item["url"] == f"https://img.test/{LOT}/P00000.png"
    assert item["filename"] == "P00000.png" and item["width"] == 300

    page2 = (await opened.get(f"/lots/{LOT}/annotations",
                              params={"limit": 100, "cursor": page1["next_cursor"]})).json()
    assert page2["items"][0]["seq"] == 101
    assert page2["total"] is None  # 只有第一頁計算總數


async def test_list_requires_open_lot(client):
    r = await client.get(f"/lots/{NEW_LOT}/annotations")
    assert r.status_code == 404 and "尚未開啟" in r.json()["detail"]


async def test_list_filters(opened):
    ids = await first_ids(opened, 3)
    await save(opened, ids[0], [{"class_id": 2, "bbox": BOX}])
    await save(opened, ids[1], [])

    async def total(**params):
        return (await opened.get(f"/lots/{LOT}/annotations", params=params)).json()["total"]

    assert await total(verdict="NG") == 1
    assert await total(verdict="OK") == 1
    assert await total(verdict="none") == 2498
    assert await total(class_id="2") == 1
    assert await total(ai="OK", verdict="none") == sum(1 for i in range(2, 2500) if i % 3)
    assert (await opened.get(f"/lots/{LOT}/annotations", params={"verdict": "bad"})).status_code == 422


async def test_facets_are_linked(opened):
    ids = await first_ids(opened, 3)  # seq 1..3 → 來源 i=0..2，i=0 的 AI 判 0（刮傷）
    await save(opened, ids[0], [{"class_id": 2, "bbox": BOX}, {"class_id": 2, "bbox": BOX}])  # AI 0、人工 2 → 類別不符
    await save(opened, ids[1], [{"class_id": 1, "bbox": BOX}])  # AI OK、人工 NG → 逃漏
    await save(opened, ids[2], [])

    f = (await opened.get(f"/lots/{LOT}/facets")).json()
    assert f["verdict"] == {"all": 2500, "counts": {"NG": 2, "OK": 1, "none": 2497}}
    assert f["class_id"]["counts"] == {"2": 1, "1": 1}  # 同一張圖兩個框只算一張
    assert f["ai_cmp"]["counts"] == {"mismatch": 1, "escape": 1}

    f = (await opened.get(f"/lots/{LOT}/facets", params={"verdict": "NG"})).json()
    assert f["verdict"]["all"] == 2500  # 自己這組不套用自己的條件
    assert f["class_id"]["all"] == 2
    assert f["ai"]["counts"] == {"0": 1, "OK": 1}


async def test_lock_holder_shown_in_list(opened, env):
    ids = await first_ids(opened, 2)
    await env.redis.set(f"dl:lock:ann:{ids[1]}", "ben")
    items = (await opened.get(f"/lots/{LOT}/annotations", params={"limit": 2})).json()["items"]
    assert items[0]["locked_by"] is None
    assert items[1]["locked_by"] == {"id": "ben", "name": "Ben"}


# ---------- 單張與儲存 ----------


async def test_get_annotation(opened):
    ann_id = (await first_ids(opened, 1))[0]
    a = (await opened.get(f"/annotations/{ann_id}")).json()
    assert a["lot"] == LOT and a["seq"] == 1 and a["verdict"] is None and a["version"] == 1
    assert a["ai"]["result"] == "0"
    assert (await opened.get("/annotations/not-an-id")).status_code == 404


async def test_save_sets_verdict_and_last_editor(opened):
    ann_id = (await first_ids(opened, 1))[0]
    r = await save(opened, ann_id, [{"class_id": 0, "bbox": BOX, "attributes": {"severity": "minor"}}])
    a = r.json()
    assert r.status_code == 200
    assert a["verdict"] == "NG" and a["defect_count"] == 1 and a["version"] == 2
    assert a["defects"][0]["class_name"] == "scratch" and a["defects"][0]["id"]
    assert a["defects"][0]["attributes"] == {"severity": "minor"}
    assert a["updated_by"] == {"id": "weichun", "name": "weichun"} and a["updated_at"]
    assert a["ai_cmp"] is None  # AI 判 0、人工也有 0

    a = (await save(opened, ann_id, [], version=2)).json()
    assert a["verdict"] == "OK" and a["defect_count"] == 0 and a["ai_cmp"] == "overkill"


async def test_save_keeps_defect_ids_and_clamps_boxes(opened):
    ann_id = (await first_ids(opened, 1))[0]
    a = (await save(opened, ann_id, [{"id": "keep-me", "class_id": 0, "bbox": {"x": 290, "y": -5, "w": 30, "h": 20.6}}])).json()
    assert a["defects"][0]["id"] == "keep-me"
    assert a["defects"][0]["bbox"] == {"x": 290, "y": 0, "w": 10, "h": 16}

    r = await save(opened, ann_id, [{"class_id": 0, "bbox": {"x": 400, "y": 10, "w": 5, "h": 5}}], version=2)
    assert r.status_code == 422 and "範圍外" in r.json()["detail"]


async def test_inactive_class_only_for_existing_boxes(opened, env):
    ann_id = (await first_ids(opened, 1))[0]
    r = await save(opened, ann_id, [{"class_id": 5, "bbox": BOX}])  # 5 = bubble，已停用
    assert r.status_code == 422 and "停用" in r.json()["detail"]

    # 舊資料裡已經有的停用類別框，可以保留（例如只移動位置）
    env.ann.update_one({"_id": __import__("bson").ObjectId(ann_id)},
                       {"$set": {"defects": [{"id": "old", "class_id": 5, "class_name": "bubble", "bbox": BOX}]}})
    r = await save(opened, ann_id, [{"id": "old", "class_id": 5, "bbox": {**BOX, "x": 11}}])
    assert r.status_code == 200
    assert (await save(opened, ann_id, [{"class_id": 99, "bbox": BOX}])).status_code == 422


async def test_version_conflict(opened):
    ann_id = (await first_ids(opened, 1))[0]
    await save(opened, ann_id, [], version=1)
    r = await save(opened, ann_id, [{"class_id": 0, "bbox": BOX}], version=1)
    assert r.status_code == 409
    assert r.json()["current"]["version"] == 2 and r.json()["current"]["verdict"] == "OK"


async def test_cannot_save_while_someone_else_holds_lock(opened, env):
    ann_id = (await first_ids(opened, 1))[0]
    await env.redis.set(f"dl:lock:ann:{ann_id}", "ben")
    r = await save(opened, ann_id, [])
    assert r.status_code == 423 and r.json()["holder"] == {"id": "ben", "name": "Ben"}


async def test_viewer_cannot_save_or_lock(opened, env):
    ann_id = (await first_ids(opened, 1))[0]
    async with make_client(opened.app, "eric") as viewer:
        assert (await viewer.get(f"/annotations/{ann_id}")).status_code == 200
        assert (await save(viewer, ann_id, [])).status_code == 403
        assert (await viewer.post(f"/annotations/{ann_id}/lock", json={"action": "acquire"})).status_code == 403
        assert (await viewer.post(f"/annotations/{ann_id}/lock", json={"action": "status"})).status_code == 200


# ---------- 編輯鎖 ----------


async def test_lock_lifecycle(opened, env):
    ann_id = (await first_ids(opened, 1))[0]
    lock = lambda c, action: c.post(f"/annotations/{ann_id}/lock", json={"action": action})  # noqa: E731

    s = (await lock(opened, "acquire")).json()
    assert s["held"] is True and s["holder"]["id"] == "weichun" and s["expires_in"] == 300

    async with make_client(opened.app, "amy") as amy:
        s = (await lock(amy, "acquire")).json()
        assert s["held"] is False and s["holder"] == {"id": "weichun", "name": "weichun"}
        assert (await lock(amy, "release")).json()["holder"]["id"] == "weichun"  # 別人不能釋放

        assert (await lock(opened, "renew")).json()["held"] is True
        assert (await lock(opened, "release")).json()["holder"] is None
        assert (await lock(amy, "acquire")).json()["held"] is True

    a = (await opened.get(f"/annotations/{ann_id}")).json()
    assert a["locked_by"] == {"id": "amy", "name": "Amy"}
    assert await env.redis.zscore(f"dl:online:{LOT}", "amy") is not None  # 線上人數


async def test_lock_degrades_when_redis_down(opened, env):
    from tests.test_home import _BrokenRedis

    ann_id = (await first_ids(opened, 1))[0]
    env.c.locks._r = _BrokenRedis()
    s = (await opened.post(f"/annotations/{ann_id}/lock", json={"action": "acquire"})).json()
    assert s["held"] is True and s["degraded"] is True


# ---------- 佇列 ----------


async def test_queue_gives_unlabeled_unlocked_images(opened, env):
    ids = await first_ids(opened, 3)
    await save(opened, ids[0], [])  # 已標註
    await env.redis.set(f"dl:lock:ann:{ids[1]}", "ben")  # 別人編輯中

    q = (await opened.post(f"/lots/{LOT}/queue/next")).json()
    assert q["id"] == ids[2] and q["remaining"] == 2499
    assert await env.redis.get(f"dl:lock:ann:{ids[2]}") == "weichun"  # 已替我取得鎖

    async with make_client(opened.app, "amy") as amy:
        q2 = (await amy.post(f"/lots/{LOT}/queue/next")).json()
        assert q2["id"] not in ids


async def test_queue_rebuilds_from_mongo_when_empty(opened, env):
    await env.redis.delete(f"dl:queue:{LOT}")
    ids = await first_ids(opened, 1)
    q = (await opened.post(f"/lots/{LOT}/queue/next")).json()
    assert q["id"] == ids[0]
    assert await env.redis.llen(f"dl:queue:{LOT}") == 2499


async def test_queue_exclude_and_finished_lot(opened, env):
    ids = await first_ids(opened, 1)
    q = (await opened.post(f"/lots/{LOT}/queue/next", params={"exclude": ids[0]})).json()
    assert q["id"] != ids[0]

    env.ann.update_many({"lot": LOT}, {"$set": {"verdict": "OK"}})
    await env.redis.delete(f"dl:queue:{LOT}")
    q = (await opened.post(f"/lots/{LOT}/queue/next")).json()
    assert q == {"id": None, "remaining": 0}


# ---------- 上一張／下一張 ----------


async def test_neighbors_in_filtered_lot(opened):
    ids = await first_ids(opened, 6)
    for i in (1, 3, 5):
        await save(opened, ids[i], [{"class_id": 0, "bbox": BOX}])
    n = (await opened.get(f"/annotations/{ids[3]}/neighbors", params={"verdict": "NG"})).json()
    assert n["prev"] == ids[1] and n["next"] == ids[5]
    assert n["position"] == 2 and n["total"] == 3

    n = (await opened.get(f"/annotations/{ids[0]}/neighbors")).json()
    assert n["prev"] is None and n["next"] == ids[1] and n["position"] == 1 and n["total"] == 2500


async def test_neighbors_in_class_across_lots(client, env):
    await open_lot(client, env, LOT)
    await open_lot(client, env, NEW_LOT)
    a = await first_ids(client, 2)
    b = [it["id"] for it in (await client.get(f"/lots/{NEW_LOT}/annotations", params={"limit": 1})).json()["items"]]
    for ann_id in (a[0], a[1], b[0]):
        await save(client, ann_id, [{"class_id": 7, "bbox": BOX}])

    n = (await client.get(f"/annotations/{a[1]}/neighbors", params={"mode": "class", "class_id": 7})).json()
    assert n["prev"] == a[0] and n["next"] == b[0] and n["next_lot"] == NEW_LOT
    assert n["position"] == 2 and n["total"] == 3
    assert (await client.get(f"/annotations/{a[1]}/neighbors", params={"mode": "class"})).status_code == 422


# ---------- 類別圖片清單 ----------


async def test_class_images(client, env):
    await open_lot(client, env, LOT)
    await open_lot(client, env, NEW_LOT)
    a = await first_ids(client, 3)
    b = (await client.get(f"/lots/{NEW_LOT}/annotations", params={"limit": 1})).json()["items"][0]["id"]
    await save(client, a[0], [{"class_id": 4, "bbox": BOX}, {"class_id": 4, "bbox": BOX}, {"class_id": 1, "bbox": BOX}])
    await save(client, a[2], [{"class_id": 4, "bbox": BOX}])
    await save(client, b, [{"class_id": 4, "bbox": BOX}])

    p1 = (await client.get("/classes/4/images", params={"limit": 2})).json()
    assert p1["total"] == 3 and [it["id"] for it in p1["items"]] == [a[0], a[2]]
    assert p1["items"][0]["class_boxes"] == 2 and p1["items"][0]["defect_count"] == 3
    p2 = (await client.get("/classes/4/images", params={"limit": 2, "cursor": p1["next_cursor"]})).json()
    assert [it["id"] for it in p2["items"]] == [b] and p2["next_cursor"] is None
    assert (await client.get("/classes/999/images")).status_code == 404


async def test_classes_endpoint(client):
    classes = (await client.get("/classes")).json()
    assert classes[0]["id"] == 0 and classes[0]["name"] == "scratch" and classes[0]["display"] == "刮傷"
    assert classes[5]["active"] is False
    assert all(c["color"].startswith("#") for c in classes)


# ---------- 統計 ----------


async def test_stats_and_cache_invalidation(opened, env):
    ids = await first_ids(opened, 3)
    await save(opened, ids[0], [{"class_id": 0, "bbox": BOX}, {"class_id": 0, "bbox": BOX}, {"class_id": 3, "bbox": BOX}])
    await save(opened, ids[1], [])

    s = (await opened.get("/stats")).json()
    assert (s["images"], s["labeled"], s["ng"], s["ok"], s["unlabeled"], s["boxes"]) == (2500, 2, 1, 1, 2498, 3)
    assert s["avg_boxes_per_ng"] == 3.0 and s["lots"] == 1
    by_id = {c["class_id"]: c for c in s["classes"]}
    assert by_id[0] == {"class_id": 0, "boxes": 2, "images": 1}
    assert by_id[3]["boxes"] == 1 and by_id[1]["boxes"] == 0
    assert len(s["classes"]) == 38
    assert await env.redis.get("dl:stats") is not None

    await save(opened, ids[2], [{"class_id": 1, "bbox": BOX}])  # 儲存時刪除快取
    assert await env.redis.get("dl:stats") is None
    assert (await opened.get("/stats")).json()["ng"] == 2


async def test_stats_only_open_lots(client, env):
    s = (await client.get("/stats")).json()
    assert s["images"] == 0 and s["lots"] == 0
    await open_lot(client, env, NEW_LOT)
    assert (await client.get("/stats")).json()["images"] == 30  # 開啟 Lot 後刪除快取
