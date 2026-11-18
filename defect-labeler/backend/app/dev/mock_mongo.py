"""模擬模式與測試用：把 mongomock（同步、記憶體）包成和 PyMongo async API 相同的介面。

只包了程式有用到的方法。mongomock 是純 Python，資料量大時會慢（模擬模式的資料量因此刻意放小）。
"""

from typing import Any

import mongomock
from pymongo import ReturnDocument, UpdateOne
from pymongo.errors import DuplicateKeyError


class AsyncMockCursor:
    def __init__(self, cursor):
        self._cursor = cursor

    def sort(self, key_or_list, direction=None):
        if direction is None:
            self._cursor = self._cursor.sort(key_or_list)
        else:
            self._cursor = self._cursor.sort(key_or_list, direction)
        return self

    def limit(self, n: int):
        self._cursor = self._cursor.limit(n)
        return self

    def skip(self, n: int):
        self._cursor = self._cursor.skip(n)
        return self

    async def to_list(self, length: int | None = None) -> list[dict]:
        out = list(self._cursor)
        return out if length is None else out[:length]

    def __aiter__(self):
        self._it = iter(self._cursor)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration from None


class AsyncMockCollection:
    """唯一索引由這裡自己檢查（mongomock 的唯一索引是逐筆掃描，上千筆就要好幾秒）。只支援單一欄位的唯一索引。"""

    def __init__(self, collection: mongomock.Collection):
        self.sync = collection  # 測試可以直接用同步介面檢查資料
        self._unique: list[str] = []

    async def create_index(self, keys, unique: bool = False, **kwargs):
        if unique:
            if not isinstance(keys, str):
                raise NotImplementedError("模擬資料庫只支援單一欄位的唯一索引")
            if keys not in self._unique:
                self._unique.append(keys)
            return keys
        return self.sync.create_index(keys, **kwargs)

    def _check_unique(self, docs: list[dict]) -> None:
        for field in self._unique:
            values = [d[field] for d in docs if field in d]
            if len(set(map(repr, values))) != len(values):
                raise DuplicateKeyError(f"duplicate key: {field}")
            if values and self.sync.find_one({field: {"$in": values}}, {"_id": 1}):
                raise DuplicateKeyError(f"duplicate key: {field}")

    def _check_upsert(self, flt: dict, update: dict) -> None:
        """upsert 沒有符合的文件時會新增：先檢查新文件會不會違反唯一索引。"""
        if not self._unique or self.sync.find_one(flt, {"_id": 1}):
            return
        new = {k: v for k, v in flt.items() if not k.startswith("$") and not isinstance(v, dict)}
        for op in ("$set", "$setOnInsert"):
            new.update(update.get(op) or {})
        self._check_unique([new])

    async def count_documents(self, flt: dict, **kwargs) -> int:
        return self.sync.count_documents(flt, **kwargs)

    async def find_one(self, flt: dict | None = None, *args, **kwargs):
        return self.sync.find_one(flt, *args, **kwargs)

    def find(self, *args, **kwargs) -> AsyncMockCursor:
        return AsyncMockCursor(self.sync.find(*args, **kwargs))

    async def find_one_and_update(self, flt, update, projection=None, return_document=ReturnDocument.BEFORE,
                                  upsert=False, **kwargs):
        if upsert:
            self._check_upsert(flt, update)
        if return_document != ReturnDocument.AFTER:
            return self.sync.find_one_and_update(flt, update, projection, upsert=upsert, **kwargs)
        # mongomock 回傳更新後的文件時會用原本的條件重查，更新改到條件欄位就查不到；改成用 _id 重查
        before = self.sync.find_one_and_update(flt, update, {"_id": 1}, upsert=upsert, **kwargs)
        if before is not None:
            return self.sync.find_one({"_id": before["_id"]}, projection)
        if not upsert:
            return None
        # 新增的文件：沒有 _id 可以查，用條件中的等值欄位找
        eq = {k: v for k, v in flt.items() if not k.startswith("$") and not isinstance(v, dict)}
        return self.sync.find_one(eq, projection)

    async def update_one(self, flt, update, *args, **kwargs):
        if kwargs.get("upsert"):
            self._check_upsert(flt, update)
        return self.sync.update_one(flt, update, *args, **kwargs)

    async def update_many(self, *args, **kwargs):
        return self.sync.update_many(*args, **kwargs)

    async def insert_one(self, doc, *args, **kwargs):
        self._check_unique([doc])
        return self.sync.insert_one(doc, *args, **kwargs)

    async def insert_many(self, docs, *args, **kwargs):
        docs = list(docs)
        self._check_unique(docs)
        return self.sync.insert_many(docs, *args, **kwargs)

    async def delete_many(self, *args, **kwargs):
        return self.sync.delete_many(*args, **kwargs)

    async def bulk_write(self, ops: list[Any], ordered: bool = True):
        # mongomock 的 bulk_write 和新版 pymongo 不相容，自己執行
        if not all(isinstance(op, UpdateOne) for op in ops):
            raise NotImplementedError("模擬資料庫的 bulk_write 只支援 UpdateOne")
        # 快速路徑：全部是「以唯一欄位為條件、只有 $setOnInsert 的 upsert」（開啟 Lot 用）
        keys = {next(iter(op._filter)) for op in ops if len(op._filter) == 1}
        if (
            len(keys) == 1
            and all(op._upsert and set(op._doc) == {"$setOnInsert"} and len(op._filter) == 1 for op in ops)
        ):
            field = keys.pop()
            values = [op._filter[field] for op in ops]
            existing = {d[field] for d in self.sync.find({field: {"$in": values}}, {field: 1})}
            new, seen = [], set()
            for op in ops:
                v = op._filter[field]
                if v in existing or v in seen:
                    continue
                seen.add(v)
                new.append({field: v, **op._doc["$setOnInsert"]})
            if new:
                self.sync.insert_many(new)
            return
        for op in ops:
            if op._upsert:
                self._check_upsert(op._filter, op._doc)
            self.sync.update_one(op._filter, op._doc, upsert=op._upsert)

    async def aggregate(self, pipeline: list[dict], **kwargs) -> AsyncMockCursor:
        return AsyncMockCursor(self.sync.aggregate(pipeline, **kwargs))


class AsyncMockDatabase:
    def __init__(self, db: mongomock.Database):
        self._db = db
        self._colls: dict[str, AsyncMockCollection] = {}

    def __getitem__(self, name: str) -> AsyncMockCollection:
        if name not in self._colls:
            self._colls[name] = AsyncMockCollection(self._db[name])
        return self._colls[name]


class AsyncMockClient:
    def __init__(self):
        self._client = mongomock.MongoClient(tz_aware=True)
        self._dbs: dict[str, AsyncMockDatabase] = {}

    def __getitem__(self, name: str) -> AsyncMockDatabase:
        if name not in self._dbs:
            self._dbs[name] = AsyncMockDatabase(self._client[name])
        return self._dbs[name]

    async def close(self) -> None:
        pass
