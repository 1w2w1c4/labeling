"""缺點類別（config/classes.yaml）。id 固定、從 0 連續；停用的保留位置。"""

import colorsys
from pathlib import Path

from pydantic import BaseModel, field_validator, model_validator

from app.core.config import load_yaml, parse_config


def default_color(class_id: int) -> str:
    """和原型相同的預設顏色：色相依 id 以黃金角分散。"""
    r, g, b = colorsys.hls_to_rgb(((class_id * 137.5) % 360) / 360, 0.50, 0.62)
    return "#{:02x}{:02x}{:02x}".format(round(r * 255), round(g * 255), round(b * 255))


class DefectClass(BaseModel):
    id: int
    name: str
    display: str = ""
    color: str = ""
    active: bool = True

    @field_validator("name", "display", mode="before")
    @classmethod
    def _to_str(cls, v):
        return "" if v is None else str(v)

    @model_validator(mode="after")
    def _defaults(self):
        self.display = self.display or self.name
        self.color = self.color or default_color(self.id)
        return self


class ClassesConfig(BaseModel):
    classes: list[DefectClass]

    @model_validator(mode="after")
    def _check(self):
        if not self.classes:
            raise ValueError("沒有任何類別")
        ids = sorted(c.id for c in self.classes)
        if ids != list(range(len(ids))):
            raise ValueError("id 必須從 0 連續且不重複")
        names = [c.name for c in self.classes]
        if len(set(names)) != len(names):
            raise ValueError("name 不能重複")
        self.classes.sort(key=lambda c: c.id)
        return self


class ClassCatalog:
    def __init__(self, config: ClassesConfig):
        self._list = config.classes

    @classmethod
    def load(cls, config_dir: Path) -> "ClassCatalog":
        return cls(parse_config(ClassesConfig, load_yaml(config_dir / "classes.yaml"), "classes.yaml"))

    def all(self) -> list[DefectClass]:
        return list(self._list)

    def get(self, class_id: int) -> DefectClass | None:
        return self._list[class_id] if 0 <= class_id < len(self._list) else None
