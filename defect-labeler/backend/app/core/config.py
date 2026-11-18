"""環境變數設定與 YAML 設定檔（config/*.yaml）的讀取與驗證。"""

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """環境變數（前綴 DL_），也可以寫在 backend/.env。"""

    model_config = SettingsConfigDict(env_prefix="DL_", env_file=".env", extra="ignore")

    mongo_uri: str = "mongodb://localhost:27017"
    mongo_db: str = "avi"
    redis_url: str = "redis://localhost:6379/0"
    config_dir: Path = BACKEND_DIR / "config"

    identity_header: str = "X-User-Id"
    dev_user_id: str | None = None  # 只限開發：沒有身分 header 時當作這個使用者

    cors_origins: list[str] = []

    init_batch_size: int = 1000  # 開啟 Lot 時每批 upsert 的筆數
    init_stale_seconds: int = 120  # 初始化超過這麼久沒有進度，視為中斷，可以重新開啟
    online_window_seconds: int = 60  # dl:online:{lot} 內多久以內的心跳算線上
    lock_ttl_seconds: int = 300  # 編輯鎖 dl:lock:ann:{id} 的秒數（前端每 60 秒續約）
    stats_ttl_seconds: int = 60  # 統計結果快取 dl:stats 的秒數
    page_limit_max: int = 500

    # 模擬模式：不連 Mongo / Redis，改用記憶體資料庫並產生假資料與假圖片
    demo: bool = False

    # 編譯好的前端（npm run build 的輸出）。存在時由後端一起提供，前端與 API 同一個網域
    frontend_dist: Path = BACKEND_DIR.parent / "frontend" / "dist"


class ConfigError(Exception):
    """設定檔讀不到或格式錯誤。啟動時直接失敗，避免帶著錯的設定運作。"""


# ---------- config/source.yaml ----------


class SourceFields(BaseModel):
    id: str = "_id"
    lot: str = "lot"
    path: str = "path"
    filename: str | None = None
    width: str | None = "width"
    height: str | None = "height"


class UrlRule(BaseModel):
    match: str
    replace: str


class SourceConfig(BaseModel):
    mongo_db: str | None = None
    mongo_collection: str = "images"
    redis_key: str = "{lot}"
    redis_ttl: int = 86400
    fill_lock_ttl: int = 60
    fields: SourceFields = Field(default_factory=SourceFields)
    default_width: int = 300
    default_height: int = 300
    meta: dict[str, str] = Field(default_factory=dict)
    ai: dict[str, str] = Field(default_factory=dict)
    url_rules: list[UrlRule] = Field(default_factory=list)


def load_yaml(path: Path) -> Any:
    try:
        with path.open(encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError as e:
        raise ConfigError(f"找不到設定檔 {path}") from e
    except yaml.YAMLError as e:
        raise ConfigError(f"{path.name} 不是正確的 YAML：{e}") from e


def parse_config[T: BaseModel](model: type[T], data: Any, filename: str) -> T:
    try:
        return model.model_validate(data)
    except ValidationError as e:
        raise ConfigError(f"{filename} 格式錯誤：\n{e}") from e


def load_source_config(config_dir: Path) -> SourceConfig:
    return parse_config(SourceConfig, load_yaml(config_dir / "source.yaml"), "source.yaml")
