"""圖片路徑 → nginx URL（config/source.yaml 的 url_rules，依序比對，第一個符合的生效）。"""

import re

from app.core.config import UrlRule


class UrlMapper:
    def __init__(self, rules: list[UrlRule]):
        self._rules = [(re.compile(r.match), r.replace) for r in rules]

    def __call__(self, path: str) -> str:
        normalized = path.replace("\\", "/")
        for pattern, repl in self._rules:
            if pattern.search(normalized):
                return pattern.sub(repl, normalized, count=1)
        return normalized  # 沒有規則符合：原樣回傳（前端會載入失敗，方便發現規則漏了）
