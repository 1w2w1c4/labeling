"""模擬模式（DL_DEMO=1）：記憶體 Mongo + fakeredis，啟動時產生假資料，並由後端提供假圖片。

- 202611-01-03：已開啟，約六成已標註，少數圖被別人鎖定中
- 202611-01-04：已開啟，全部標註完成
- 202611-02-01：尚未開啟（可以測試主頁的「開啟 Lot」）
重啟後資料會重新產生（不保存）。
"""

import random
import struct
import zlib
from datetime import UTC, datetime, timedelta
from functools import lru_cache

from fastapi import APIRouter, Response

DEMO_LOTS = {
    # lot: (張數, 產品, 站點, 已標註比例)
    "202611-01-03": (3000, "PCB-A12", "AOI-03", 0.6),
    "202611-01-04": (800, "PCB-A12", "AOI-03", 1.0),
    "202611-02-01": (1200, "PCB-B07", "AOI-05", None),  # None = 不開啟
}
IMAGE_SIZE = 300
EDITORS = ["weichun", "amy", "ben", "chris", "dana"]
SIZE = IMAGE_SIZE


def demo_source_docs() -> list[dict]:
    """來源圖片資料（欄位名稱對應 config/source.yaml 的預設值）。"""
    docs = []
    for lot, (count, product, station, _) in DEMO_LOTS.items():
        rng = random.Random(lot)
        for i in range(count):
            ai_ok = rng.random() < 0.65
            docs.append({
                "_id": f"{lot}-{i + 1:05d}",
                "lot": lot,
                "path": f"/data/{lot}/IMG_{i + 1:05d}.png",
                "width": IMAGE_SIZE,
                "height": IMAGE_SIZE,
                "product": product,
                "station": station,
                "captured_at": datetime(2026, 11, 10, 8, tzinfo=UTC) + timedelta(seconds=i * 7),
                "ai_result": "OK" if ai_ok else str(_pick_class(rng)),
                "ai_score": round(0.5 + rng.random() * 0.49, 2),
                "ai_model": "avi-cls-v3",
            })
    return docs


# 和原型相近的類別分布：前幾類比較多
_HEAD = [0.28, 0.16, 0.14, 0.09, 0.09, 0.0, 0.11]  # 5 = bubble 已停用，不產生新的


def _pick_class(rng: random.Random, n_classes: int = 38) -> int:
    r, acc = rng.random(), 0.0
    rest = (1 - sum(_HEAD)) / (n_classes - len(_HEAD))
    for cid in range(n_classes):
        acc += _HEAD[cid] if cid < len(_HEAD) else rest
        if r < acc:
            return cid
    return 0


def demo_labels(lot: str, ann: dict, rng: random.Random, class_names: dict[int, str]) -> dict:
    """依 AI 結果產生一筆「看起來合理」的人工標註。"""
    ai = (ann.get("ai") or {}).get("result", "OK")
    if ai == "OK":
        ng = rng.random() < 0.08  # 少數逃漏
    else:
        ng = rng.random() < 0.85  # 少數過殺
    defects = []
    if ng:
        for j in range(1 + int(rng.random() ** 2 * 4)):
            cid = int(ai) if ai != "OK" and j == 0 and rng.random() < 0.85 else _pick_class(rng)
            w, h = int(4 + rng.random() ** 2 * 70), int(4 + rng.random() ** 2 * 60)
            x, y = rng.randrange(0, SIZE - w), rng.randrange(0, SIZE - h)
            defects.append({
                "id": f"{ann['_id']}-d{j}", "class_id": cid, "class_name": class_names.get(cid, str(cid)),
                "bbox": {"x": x, "y": y, "w": w, "h": h}, "attributes": {},
            })
    return {"defects": defects, "verdict": "NG" if defects else "OK"}


# ---------- 假圖片（PCB 風格的 300×300 PNG，不需要任何影像套件） ----------


def _png(width: int, height: int, rgb: bytearray) -> bytes:
    raw = b"".join(b"\x00" + bytes(rgb[y * width * 3 : (y + 1) * width * 3]) for y in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


@lru_cache(maxsize=24)
def demo_image(variant: int) -> bytes:
    rng = random.Random(variant * 7919 + 13)
    w = h = SIZE
    buf = bytearray(w * h * 3)

    def rect(x1, y1, x2, y2, color):
        x1, x2 = max(0, int(x1)), min(w, int(x2))
        y1, y2 = max(0, int(y1)), min(h, int(y2))
        if x2 <= x1:
            return
        row = bytes(color) * (x2 - x1)
        for y in range(y1, y2):
            off = (y * w + x1) * 3
            buf[off : off + len(row)] = row

    base = (18 + variant % 4 * 4, 70 + variant % 5 * 6, 44 + variant % 3 * 5)
    rect(0, 0, w, h, base)
    for _ in range(500):  # 細微雜訊
        x, y = rng.randrange(w), rng.randrange(h)
        c = tuple(min(255, v + rng.randrange(6, 18)) for v in base)
        rect(x, y, x + 2, y + 2, c)
    trace = (196, 162, 86)
    for _ in range(14):  # 銅線
        x, y, t = rng.randrange(w), rng.randrange(h), rng.randrange(2, 5)
        for _ in range(3):
            if rng.random() < 0.5:
                nx = rng.randrange(w)
                rect(min(x, nx), y, max(x, nx) + t, y + t, trace)
                x = nx
            else:
                ny = rng.randrange(h)
                rect(x, min(y, ny), x + t, max(y, ny) + t, trace)
                y = ny
    for _ in range(24):  # 焊墊
        x, y, s = rng.randrange(w), rng.randrange(h), rng.randrange(4, 9)
        rect(x, y, x + s, y + s, (214, 190, 120))
    for _ in range(3):  # 元件
        x, y = 20 + rng.randrange(220), 20 + rng.randrange(200)
        bw, bh = 30 + rng.randrange(50), 20 + rng.randrange(30)
        for p in range(0, bw, 6):
            rect(x + p, y - 4, x + p + 3, y, (200, 200, 200))
            rect(x + p, y + bh, x + p + 3, y + bh + 4, (200, 200, 200))
        rect(x, y, x + bw, y + bh, (27, 27, 29))
    return _png(w, h, buf)


router = APIRouter(include_in_schema=False)


@router.get("/demo-images/{path:path}")
async def demo_image_route(path: str):
    variant = zlib.crc32(path.encode()) % 24
    return Response(demo_image(variant), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ---------- 產生假資料 ----------


async def seed_demo(c) -> None:
    """c：app.main.Container（模擬模式）。依 DEMO_LOTS 寫入來源資料、開啟 Lot、產生標註與鎖。"""
    import logging

    from app.services.annotations import compute_ai_cmp

    log = logging.getLogger(__name__)
    source = c.source._coll
    await source.insert_many(demo_source_docs())

    for lot, (_, _, _, ratio) in DEMO_LOTS.items():
        if ratio is not None:
            await c.lot_service.open(lot, "weichun")
    await c.tasks.wait_all()

    class_names = {cl.id: cl.name for cl in c.classes.all()}
    n_classes = len(class_names)
    coll = c.annotations._c.sync  # 模擬資料庫的同步介面，直接改資料比較快
    now = datetime.now(UTC)
    for lot, (_, _, _, ratio) in DEMO_LOTS.items():
        if ratio is None:
            continue
        rng = random.Random(lot + ":labels")
        for ann in coll.find({"lot": lot}, {"_id": 1, "ai": 1}).sort("seq", 1):
            if rng.random() >= ratio:
                continue
            labels = demo_labels(lot, ann, rng, class_names)
            for d in labels["defects"]:
                d["class_id"] %= n_classes
                d["class_name"] = class_names[d["class_id"]]
            coll.update_one({"_id": ann["_id"]}, {"$set": {
                **labels,
                "defect_count": len(labels["defects"]),
                "ai_cmp": compute_ai_cmp(labels["verdict"], ann.get("ai"), {d["class_id"] for d in labels["defects"]}),
                "updated_by": rng.choice(EDITORS),
                "updated_at": now - timedelta(minutes=rng.randrange(1, 60 * 48)),
                "version": 1 + rng.randrange(1, 4),
            }})
        # 重建佇列，並讓幾張未標註的圖顯示「別人正在編輯」
        ids = [i async for i in c.annotations.unlabeled_ids(lot)]
        await c.queue.rebuild(lot, ids)
        for ann_id, who in zip(ids[3:8], ["ben", "amy", "chris", "ben", "dana"], strict=False):
            await c.redis.set(f"dl:lock:ann:{ann_id}", who, ex=3600)
        for who in ("ben", "amy", "chris"):
            await c.presence.touch(lot, who)
    await c.stats.invalidate()
    log.info("模擬資料已產生：%s", "、".join(DEMO_LOTS))
