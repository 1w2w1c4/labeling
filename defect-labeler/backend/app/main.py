"""後端進入點：uvicorn app.main:app --reload

DL_DEMO=1 時為模擬模式：不連 Mongo / Redis，改用記憶體資料庫並產生假資料與假圖片。
"""

import logging
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import annotations, classes, lots, me, stats
from app.api.deps import install_error_handlers
from app.core.cache import create_redis
from app.core.config import Settings, SourceConfig, UrlRule, load_source_config
from app.core.identity import UserDirectory
from app.core.tasks import TaskRunner
from app.models.defect_class import ClassCatalog
from app.repositories.annotation import AnnotationRepo
from app.repositories.lot import LotRepo
from app.repositories.lot_source import LotSource
from app.services.annotations import AnnotationService
from app.services.locking import LockService
from app.services.lots import LotService
from app.services.presence import Presence
from app.services.queue import AnnotationQueue
from app.services.stats import StatsService
from app.services.url_mapper import UrlMapper

log = logging.getLogger(__name__)


@dataclass
class Container:
    """執行期需要的所有物件（app.state.c）。"""

    settings: Settings
    users: UserDirectory
    classes: ClassCatalog
    tasks: TaskRunner
    source: LotSource
    lots: LotRepo
    annotations: AnnotationRepo
    locks: LockService
    presence: Presence
    queue: AnnotationQueue
    stats: StatsService
    lot_service: LotService
    annotation_service: AnnotationService
    redis: object = None
    close: Callable[[], Awaitable[None]] | None = field(default=None, repr=False)

    async def ensure_indexes(self) -> None:
        await self.lots.ensure_indexes()
        await self.annotations.ensure_indexes()


def build_container(
    settings: Settings,
    db,  # 標註資料庫（lots、annotations）
    source_collection,  # 既有的圖片資料
    redis,
    source_cfg: SourceConfig,
) -> Container:
    users = UserDirectory.load(settings.config_dir)
    catalog = ClassCatalog.load(settings.config_dir)
    tasks = TaskRunner()
    lots_repo = LotRepo(db["lots"])
    ann_repo = AnnotationRepo(db["annotations"])
    locks = LockService(redis, settings.lock_ttl_seconds)
    presence = Presence(redis, settings.online_window_seconds)
    queue = AnnotationQueue(redis)
    stats = StatsService(ann_repo, lots_repo, catalog, redis, settings.stats_ttl_seconds)
    source = LotSource(source_collection, redis, source_cfg, tasks.spawn)
    return Container(
        settings=settings,
        users=users,
        classes=catalog,
        tasks=tasks,
        source=source,
        lots=lots_repo,
        annotations=ann_repo,
        locks=locks,
        presence=presence,
        queue=queue,
        stats=stats,
        redis=redis,
        lot_service=LotService(
            source=source, lots=lots_repo, annotations=ann_repo, queue=queue, presence=presence,
            tasks=tasks, settings=settings, on_opened=stats.invalidate,
        ),
        annotation_service=AnnotationService(
            annotations=ann_repo, lots=lots_repo, locks=locks, presence=presence, stats=stats,
            classes=catalog, users=users, url_for=UrlMapper(source_cfg.url_rules),
        ),
    )


async def build_real(settings: Settings) -> Container:
    from app.core.db import create_mongo

    source_cfg = load_source_config(settings.config_dir)
    mongo = create_mongo(settings.mongo_uri)
    redis = create_redis(settings.redis_url)
    source_coll = mongo[source_cfg.mongo_db or settings.mongo_db][source_cfg.mongo_collection]
    c = build_container(settings, mongo[settings.mongo_db], source_coll, redis, source_cfg)
    await c.ensure_indexes()

    async def close() -> None:
        await c.tasks.shutdown()
        await redis.aclose()
        await mongo.close()

    c.close = close
    return c


async def build_demo(settings: Settings) -> Container:
    import fakeredis

    from app.dev.demo import seed_demo
    from app.dev.mock_mongo import AsyncMockClient

    source_cfg = load_source_config(settings.config_dir)
    # 模擬模式：來源欄位用 source.yaml 的預設值，圖片改由後端的 /demo-images 提供
    source_cfg = source_cfg.model_copy(update={
        "fields": SourceConfig().fields,
        "meta": {"product": "product", "station": "station", "captured_at": "captured_at"},
        "ai": {"result": "ai_result", "score": "ai_score", "model": "ai_model"},
        "url_rules": [UrlRule(match=r"^/data/(.*)$", replace=r"/demo-images/\1")],
    })
    client = AsyncMockClient()
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    c = build_container(settings, client["demo"], client["source"]["images"], redis, source_cfg)
    await c.ensure_indexes()
    await seed_demo(c)

    async def close() -> None:
        await c.tasks.shutdown()

    c.close = close
    return c


def create_app(settings: Settings | None = None, container: Container | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        c = container
        if c is None:
            c = await (build_demo(settings) if settings.demo else build_real(settings))
        app.state.settings = settings
        app.state.users = c.users
        app.state.c = c
        if settings.demo:
            log.warning("模擬模式：資料都在記憶體裡，重啟後重新產生")
        if settings.dev_user_id:
            log.warning("開發模式：沒有身分 header 時當作使用者 %s（正式環境請移除 DL_DEV_USER_ID）", settings.dev_user_id)
        try:
            yield
        finally:
            if c.close is not None:
                await c.close()

    app = FastAPI(title="Labelme", version="0.2.0", lifespan=lifespan)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"]
        )
    install_error_handlers(app)
    for r in (me.router, lots.router, annotations.router, classes.router, stats.router):
        app.include_router(r, prefix="/api")
    if settings.demo:
        from app.dev.demo import router as demo_router

        app.include_router(demo_router)

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        return {"ok": True}

    mount_frontend(app, settings.frontend_dist)
    return app


def mount_frontend(app: FastAPI, dist) -> None:
    """提供編譯好的前端（SPA）：/assets 為靜態檔，其餘非 /api 的路徑都回 index.html。"""
    from pathlib import Path

    from fastapi import HTTPException
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    dist = Path(dist)
    index = dist / "index.html"
    if not index.is_file():
        return
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith(("api/", "demo-images/")):
            raise HTTPException(404)
        file = (dist / path).resolve()
        if path and file.is_file() and dist.resolve() in file.parents:
            return FileResponse(file)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = create_app()
