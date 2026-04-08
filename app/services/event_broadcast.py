"""全局事件广播器 — 将 Agent 活动事件推送给所有 SSE 订阅者。"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict

log = logging.getLogger(__name__)

_SENTINEL = object()


class EventBroadcast:
    """基于 asyncio.Queue 的发布/订阅广播器，支持多个 SSE 客户端同时监听。"""

    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue] = []

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._subscribers.append(q)
        log.info("SSE 订阅者 +1, 当前 %d 个", len(self._subscribers))
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass
        log.info("SSE 订阅者 -1, 当前 %d 个", len(self._subscribers))

    async def publish(self, event_type: str, data: Dict[str, Any], source: str = "job") -> None:
        """向所有订阅者广播事件。source 标记来源（job / chat），便于前端去重。"""
        event = {"event": event_type, "data": {**data, "_source": source}}
        dead: list[asyncio.Queue] = []
        for q in self._subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass
            log.warning("SSE 订阅者队列满，已移除")


broadcast = EventBroadcast()
