from fastapi import APIRouter, Depends, Query

from app.api.deps import page_limit, services
from app.core.identity import CurrentUser, require
from app.models.annotation import ClassImagePage
from app.models.defect_class import DefectClass

router = APIRouter(prefix="/classes", tags=["classes"])


@router.get("", response_model=list[DefectClass])
async def list_classes(_: CurrentUser = Depends(require("view")), c=Depends(services)):
    """缺點類別（config/classes.yaml），依 id 排序，包含停用的類別（active=false）。"""
    return c.classes.all()


@router.get("/{class_id}/images", response_model=ClassImagePage)
async def class_images(
    class_id: int,
    cursor: str | None = Query(None),
    limit: int = Depends(page_limit),
    _: CurrentUser = Depends(require("view")),
    c=Depends(services),
):
    """類別圖片清單：跨全部已開啟的 Lot，框過該類別的圖（依 Lot、序號排序）。"""
    return await c.annotation_service.class_images(class_id, cursor, limit)
