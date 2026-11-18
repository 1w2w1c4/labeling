from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from app.api.deps import list_filter, services
from app.core.identity import CurrentUser, current_user, require
from app.models.annotation import AnnotationOut, AnnotationSave, LockState, Neighbors
from app.repositories.annotation import ListFilter
from app.services.annotations import NotFound

router = APIRouter(prefix="/annotations", tags=["annotations"])


@router.get("/{ann_id}", response_model=AnnotationOut)
async def get_annotation(ann_id: str, _: CurrentUser = Depends(require("view")), c=Depends(services)):
    """標註頁的完整資料（含圖片 URL、AI 結果、最後修改人員與時間、目前誰在編輯）。"""
    return await c.annotation_service.get(ann_id)


@router.put(
    "/{ann_id}",
    response_model=AnnotationOut,
    responses={409: {"description": "版本衝突（current 為最新資料）"}, 423: {"description": "別人正在編輯"}},
)
async def save_annotation(
    ann_id: str, body: AnnotationSave, user: CurrentUser = Depends(require("annotate")), c=Depends(services)
):
    """儲存（整個 defects 陣列替換）。有框 = NG、沒框 = OK。帶的 version 必須是目前版本。"""
    return await c.annotation_service.save(ann_id, body, user)


@router.post("/{ann_id}/lock", response_model=LockState)
async def lock(
    ann_id: str,
    action: Literal["acquire", "renew", "release", "status"] = Body("acquire", embed=True),
    user: CurrentUser = Depends(current_user),
    c=Depends(services),
):
    """編輯鎖。進入標註頁 acquire、每 60 秒 renew（心跳）、離開時 release。

    別人持有時 held=false，holder 為持有者；Redis 無法使用時 degraded=true（不擋編輯）。
    """
    if action in ("acquire", "renew") and not user.can("annotate"):
        raise HTTPException(403, "權限不足")
    doc = await c.annotations.get(ann_id)
    if doc is None:
        raise NotFound()
    result = await getattr(c.locks, action)(ann_id, user.id)
    if action in ("acquire", "renew"):
        await c.presence.touch(doc["lot"], user.id)
    return LockState(
        held=result.held,
        holder=c.annotation_service.user_ref(result.holder),
        expires_in=result.ttl,
        degraded=result.degraded,
    )


@router.get("/{ann_id}/neighbors", response_model=Neighbors)
async def neighbors(
    ann_id: str,
    mode: Literal["lot", "class"] = Query("lot", description="lot：Lot 篩選結果內；class：跨全部 Lot、該類別內"),
    flt: ListFilter = Depends(list_filter),
    _: CurrentUser = Depends(require("view")),
    c=Depends(services),
):
    """上一張／下一張與目前位置。佇列模式（開始標註）改用 POST /lots/{lot}/queue/next。"""
    if mode == "class":
        if flt.class_id == "":
            raise HTTPException(422, "mode=class 必須帶 class_id")
        return await c.annotation_service.neighbors_class(ann_id, int(flt.class_id))
    return await c.annotation_service.neighbors_lot(ann_id, flt)
