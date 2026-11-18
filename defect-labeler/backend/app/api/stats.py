from fastapi import APIRouter, Depends, Query

from app.api.deps import services
from app.core.identity import CurrentUser, require
from app.models.annotation import StatsOut

router = APIRouter(tags=["stats"])


@router.get("/stats", response_model=StatsOut)
async def stats(
    refresh: bool = Query(False, description="true：不用快取，重新計算"),
    _: CurrentUser = Depends(require("view")),
    c=Depends(services),
):
    """缺點分布統計（全部已開啟的 Lot）。結果快取 60 秒，cached_at 為計算時間。"""
    return await c.stats.get(refresh=refresh)
