"""使用者身分與權限。

- 不做登入：身分由外部帶進來（目前假設是 HTTP header，見 Settings.identity_header）。
- config/users.yaml 只管理「誰有哪些權限」。
- 不在清單或已停用 → 401；權限不足 → 403。
"""

from pathlib import Path
from typing import Literal

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, field_validator, model_validator

from app.core.config import load_yaml, parse_config

Permission = Literal["view", "open_lot", "annotate"]


class UserEntry(BaseModel):
    id: str
    name: str | None = None
    role: str
    active: bool = True

    @field_validator("id", "name", mode="before")
    @classmethod
    def _to_str(cls, v):
        return None if v is None else str(v)


class UsersConfig(BaseModel):
    roles: dict[str, list[Permission]]
    users: list[UserEntry]

    @model_validator(mode="after")
    def _check(self):
        seen: set[str] = set()
        for u in self.users:
            if u.id in seen:
                raise ValueError(f"使用者 id「{u.id}」重複")
            seen.add(u.id)
            if u.role not in self.roles:
                raise ValueError(f"{u.id} 的角色「{u.role}」沒有定義在 roles")
        return self


class CurrentUser(BaseModel):
    id: str
    name: str
    role: str
    permissions: list[Permission]

    def can(self, perm: Permission) -> bool:
        return perm in self.permissions


class UserDirectory:
    """users.yaml 的內容，啟動時載入，修改後重啟生效。"""

    def __init__(self, config: UsersConfig):
        self._roles = config.roles
        self._users = {u.id: u for u in config.users}

    @classmethod
    def load(cls, config_dir: Path) -> "UserDirectory":
        return cls(parse_config(UsersConfig, load_yaml(config_dir / "users.yaml"), "users.yaml"))

    def resolve(self, user_id: str) -> CurrentUser | None:
        u = self._users.get(user_id)
        if u is None or not u.active:
            return None
        return CurrentUser(id=u.id, name=u.name or u.id, role=u.role, permissions=self._roles[u.role])

    def display_name(self, user_id: str) -> str:
        """顯示用的名字（停用的使用者照常顯示）。"""
        u = self._users.get(user_id)
        return (u.name or u.id) if u else user_id


def current_user(request: Request) -> CurrentUser:
    settings = request.app.state.settings
    user_id = (request.headers.get(settings.identity_header) or "").strip() or settings.dev_user_id
    if not user_id:
        raise HTTPException(401, "無法取得使用者身分")
    user = request.app.state.users.resolve(user_id)
    if user is None:
        raise HTTPException(401, f"使用者「{user_id}」沒有使用權限")
    return user


def require(perm: Permission):
    """路由的權限檢查：Depends(require("open_lot"))。"""

    def dep(user: CurrentUser = Depends(current_user)) -> CurrentUser:
        if not user.can(perm):
            raise HTTPException(403, "權限不足")
        return user

    return dep
