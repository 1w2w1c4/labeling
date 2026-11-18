"""背景工作：保留 task 參考避免被回收，記錄例外，關閉時取消。"""

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

log = logging.getLogger(__name__)


class TaskRunner:
    def __init__(self) -> None:
        self._tasks: set[asyncio.Task] = set()

    def spawn(self, coro: Coroutine[Any, Any, Any], name: str | None = None) -> asyncio.Task:
        task = asyncio.create_task(coro, name=name)
        self._tasks.add(task)
        task.add_done_callback(self._done)
        return task

    def _done(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("背景工作 %s 失敗", task.get_name(), exc_info=task.exception())

    async def wait_all(self) -> None:
        """測試用：等目前所有背景工作結束（包含工作中再產生的工作）。"""
        while self._tasks:
            pending = list(self._tasks)
            await asyncio.gather(*pending, return_exceptions=True)
            self._tasks.difference_update(t for t in pending if t.done())
            await asyncio.sleep(0)  # 讓工作中新產生的工作有機會登記

    async def shutdown(self) -> None:
        for t in list(self._tasks):
            t.cancel()
        await asyncio.gather(*list(self._tasks), return_exceptions=True)
