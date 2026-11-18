from datetime import UTC, datetime

import fakeredis
import httpx
import pytest
from asgi_lifespan import LifespanManager

from app.core.config import BACKEND_DIR, Settings, UrlRule, load_source_config
from app.dev.mock_mongo import AsyncMockClient
from app.main import build_container, create_app

CONFIG_DIR = BACKEND_DIR / "config"

LOT = "202611-01-03"
NEW_LOT = "202611-02-01"


def make_images(lot: str, n: int, product="PCB-A12", station="AOI-03") -> list[dict]:
    return [
        {
            "_id": f"{lot}-{i:05d}",
            "lot": lot,
            "path": f"/data/{lot}/P{i:05d}.png",
            "product": product,
            "station": station,
            "ai_result": "OK" if i % 3 else "0",
            "ai_score": 0.9,
            "captured_at": datetime(2026, 11, 1, tzinfo=UTC),
        }
        for i in range(n)
    ]


class Env:
    """測試環境：mongomock + fakeredis + 真正的 repository / service。"""

    def __init__(self, source_docs: list[dict]):
        self.settings = Settings(config_dir=CONFIG_DIR, dev_user_id=None, _env_file=None)
        cfg = load_source_config(CONFIG_DIR).model_copy(
            update={"url_rules": [UrlRule(match=r"^/data/(.*)$", replace=r"https://img.test/\1")]}
        )
        client = AsyncMockClient()
        self.redis = fakeredis.FakeAsyncRedis(decode_responses=True)
        self.source_coll = client["source"]["images"]
        self.source_docs = source_docs
        self.c = build_container(self.settings, client["t"], self.source_coll, self.redis, cfg)
        self.ann = self.c.annotations._c.sync  # 同步介面，方便檢查資料
        self.lots = self.c.lots._c.sync

    @property
    def tasks(self):
        return self.c.tasks

    async def setup(self):
        await self.c.ensure_indexes()
        if self.source_docs:
            await self.source_coll.insert_many(self.source_docs)

    def app(self):
        return create_app(self.settings, self.c)


@pytest.fixture
async def env():
    e = Env(make_images(LOT, 2500) + make_images(NEW_LOT, 30, station="AOI-05"))
    await e.setup()
    yield e
    await e.tasks.shutdown()


def make_client(app, user="weichun"):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test/api", headers={"X-User-Id": user}
    )


@pytest.fixture
async def client(env):
    app = env.app()
    async with LifespanManager(app):
        async with make_client(app) as c:
            c.app = app
            yield c


async def open_lot(client, env, lot=LOT):
    r = await client.post(f"/lots/{lot}/open")
    await env.tasks.wait_all()
    return r
