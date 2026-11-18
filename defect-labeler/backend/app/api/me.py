from fastapi import APIRouter, Depends

from app.core.identity import CurrentUser, current_user

router = APIRouter(tags=["me"])


@router.get("/me", response_model=CurrentUser)
async def me(user: CurrentUser = Depends(current_user)) -> CurrentUser:
    """目前使用者的 id、name、role、權限（前端依此顯示名字、隱藏沒有權限的按鈕）。"""
    return user
