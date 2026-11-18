"""Mongo 連線（PyMongo 內建的 async API）。"""

from pymongo import AsyncMongoClient


def create_mongo(uri: str) -> AsyncMongoClient:
    # tz_aware：讀出來的時間都帶時區（UTC），避免和 datetime.now(UTC) 比較出錯
    return AsyncMongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=5000)
