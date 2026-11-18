from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from app.api.deps import list_filter, page_limit, services
from app.core.identity import CurrentUser, require
from app.models.annotation import AnnotationPage, Facets, QueueNext
from app.models.lot import LotInfo, lot_param
from app.repositories.annotation import ListFilter
from app.services.lots import LotNotFound

router = APIRouter(prefix="/lots", tags=["lots"])


def _not_found(lot: str) -> HTTPException:
    return HTTPException(404, f"找不到 Lot「{lot}」，請確認編號是否正確")


@router.get("/{lot}", response_model=LotInfo)
async def get_lot(lot: str = Depends(lot_param), _: CurrentUser = Depends(require("view")), c=Depends(services)):
    """主頁查詢 Lot：圖片數量、產品／站點、開啟狀態與標註進度。開啟中時前端輪詢這個 API。"""
    try:
        return await c.lot_service.info(lot)
    except LotNotFound:
        raise _not_found(lot) from None


@router.post("/{lot}/open", response_model=LotInfo, status_code=202)
async def open_lot(
    lot: str = Depends(lot_param), user: CurrentUser = Depends(require("open_lot")), c=Depends(services)
):
    """開啟 Lot（背景建立標註紀錄）。已開啟時回 200 和目前狀態，不會重複建立。"""
    try:
        info = await c.lot_service.open(lot, user.id)
    except LotNotFound:
        raise _not_found(lot) from None
    if info.status == "open":
        return JSONResponse(info.model_dump(mode="json"), status_code=200)
    return info


@router.get("/{lot}/annotations", response_model=AnnotationPage)
async def list_annotations(
    lot: str = Depends(lot_param),
    flt: ListFilter = Depends(list_filter),
    cursor: str | None = Query(None, description="上一頁回傳的 next_cursor"),
    limit: int = Depends(page_limit),
    _: CurrentUser = Depends(require("view")),
    c=Depends(services),
):
    """Lot 圖片清單（依序號排序，cursor 分頁）。第一頁會附上符合條件的總張數。"""
    return await c.annotation_service.list_lot(lot, flt, cursor, limit)


@router.get("/{lot}/facets", response_model=Facets)
async def facets(
    lot: str = Depends(lot_param),
    flt: ListFilter = Depends(list_filter),
    _: CurrentUser = Depends(require("view")),
    c=Depends(services),
):
    """各篩選選項的張數（每一組只套用其他組的條件，選項彼此連動）。"""
    return await c.annotation_service.facets(lot, flt)


@router.post("/{lot}/queue/next", response_model=QueueNext)
async def queue_next(
    lot: str = Depends(lot_param),
    exclude: str | None = Query(None, description="略過這張（通常是目前這張）"),
    user: CurrentUser = Depends(require("annotate")),
    c=Depends(services),
):
    """開始標註／佇列模式的下一張：未標註且沒人鎖定的圖，回傳前已替你取得編輯鎖。"""
    await c.annotation_service.require_open(lot)
    ann_id = await c.queue.next(lot, user.id, c.annotations, c.locks, exclude=exclude)
    return QueueNext(id=ann_id, remaining=await c.annotations.count_unlabeled(lot))
