"""API 共用：取得服務物件、篩選參數、錯誤轉換。"""

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from app.repositories.annotation import ListFilter
from app.services.annotations import Conflict, Invalid, LockedByOther, NotFound

VERDICTS = {"", "NG", "OK", "none"}
AI_CMPS = {"", "escape", "overkill", "mismatch"}


def services(request: Request):
    """app.state.c：main.py 建立的 Container。"""
    return request.app.state.c


def list_filter(
    verdict: str = Query("", description="NG / OK / none（未標註）"),
    class_id: str = Query("", description="缺點類別 id"),
    ai: str = Query("", description="AI 結果：OK 或類別 id"),
    ai_cmp: str = Query("", description="escape（逃漏）/ overkill（過殺）/ mismatch（類別不符）"),
) -> ListFilter:
    if verdict not in VERDICTS:
        raise HTTPException(422, f"verdict 只能是 NG、OK 或 none，收到「{verdict}」")
    if class_id != "" and not class_id.isdigit():
        raise HTTPException(422, f"class_id 必須是數字，收到「{class_id}」")
    if ai_cmp not in AI_CMPS:
        raise HTTPException(422, f"ai_cmp 只能是 escape、overkill 或 mismatch，收到「{ai_cmp}」")
    return ListFilter(verdict=verdict, class_id=class_id, ai=ai, ai_cmp=ai_cmp)


def page_limit(request: Request, limit: int = Query(200, ge=1)) -> int:
    return min(limit, request.app.state.settings.page_limit_max)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(NotFound)
    async def _not_found(_, e: NotFound):
        return JSONResponse({"detail": e.message}, status_code=404)

    @app.exception_handler(Invalid)
    async def _invalid(_, e: Invalid):
        return JSONResponse({"detail": e.message}, status_code=422)

    @app.exception_handler(Conflict)
    async def _conflict(_, e: Conflict):
        return JSONResponse(
            {"detail": "這張圖已經被別人修改過，請重新載入後再修改", "current": e.current}, status_code=409
        )

    @app.exception_handler(LockedByOther)
    async def _locked(_, e: LockedByOther):
        return JSONResponse(
            {"detail": f"{e.holder.name} 正在編輯這張圖", "holder": e.holder.model_dump()}, status_code=423
        )
