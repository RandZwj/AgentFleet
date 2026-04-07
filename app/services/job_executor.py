"""Job 后台执行器 — 接收外部任务，调用 dispatcher / run_agent，回写结果。"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, Optional

import httpx

from app.config import settings
from app.models import now_iso

log = logging.getLogger(__name__)


async def run_job(
    job_id: str,
    task: str,
    context: Optional[Dict[str, Any]],
    agent_slug: Optional[str],
    callback_url: Optional[str],
    timeout_seconds: int,
) -> None:
    """后台执行一个 Job：调度 / 直接执行 → 更新 store → 可选回调。"""
    from app.store import store

    store.update_job(job_id, status="running")
    t0 = time.monotonic()

    try:
        result = await asyncio.wait_for(
            _execute(task, context, agent_slug),
            timeout=timeout_seconds,
        )

        duration_ms = int((time.monotonic() - t0) * 1000)

        dispatched_agents = _extract_dispatched_agents(result)
        summary = _extract_summary(result)
        usage = _extract_usage(result)
        messages = result.get("messages", [])

        store.update_job(
            job_id,
            status="succeeded",
            dispatched_agents=dispatched_agents,
            result={"agent_count": len(dispatched_agents)},
            summary=summary,
            messages=messages,
            usage=usage,
            duration_ms=duration_ms,
            updated_at=now_iso(),
        )

    except asyncio.TimeoutError:
        duration_ms = int((time.monotonic() - t0) * 1000)
        log.warning("Job %s 超时 (%ds)", job_id, timeout_seconds)
        store.update_job(
            job_id,
            status="failed",
            error=f"任务超时（{timeout_seconds}秒）",
            duration_ms=duration_ms,
            updated_at=now_iso(),
        )

    except Exception as e:
        duration_ms = int((time.monotonic() - t0) * 1000)
        log.exception("Job %s 执行异常", job_id)
        store.update_job(
            job_id,
            status="failed",
            error=str(e)[:500],
            duration_ms=duration_ms,
            updated_at=now_iso(),
        )

    if callback_url:
        await _send_callback(job_id, callback_url)


async def _execute(
    task: str,
    context: Optional[Dict[str, Any]],
    agent_slug: Optional[str],
) -> Dict[str, Any]:
    """根据是否指定 agent_slug 选择调度或直接执行。"""
    from app.services.agents.dispatcher import dispatch
    from app.services.agents.registry import load_agent_registry
    from app.services.agents.runner import run_agent

    user_message = task
    if context:
        user_message += f"\n\n附加上下文：{context}"

    # 加载 per-agent 模型配置
    agent_models: Dict[str, Dict[str, str]] = {}
    try:
        from app.office.store import office_store
        if office_store is not None:
            agent_models = office_store.get_agent_model_configs()
    except Exception:
        pass

    if agent_slug:
        registry = load_agent_registry()
        agent_defn = registry.get(agent_slug, {})
        if not agent_defn:
            return {
                "messages": [{
                    "role": "system",
                    "content": f"未找到 Agent: {agent_slug}",
                    "message_type": "error",
                }],
            }

        target_model = None
        target_api_base = None
        target_api_key = None
        if agent_models and agent_slug in agent_models:
            ac = agent_models[agent_slug]
            target_model = ac.get("model_name") or None
            target_api_base = ac.get("api_base") or None
            target_api_key = ac.get("api_key") or None
        target_model = target_model or agent_defn.get("model_name")

        return await run_agent(
            agent_slug=agent_slug,
            agent_defn=agent_defn,
            user_message=user_message,
            task_summary=task,
            model=target_model,
            api_base=target_api_base,
            api_key=target_api_key,
        )
    else:
        dispatcher_cfg = agent_models.get("dispatcher", {})
        dispatcher_model = dispatcher_cfg.get("model_name") if dispatcher_cfg else None

        return await dispatch(
            user_message=user_message,
            dispatcher_model=dispatcher_model,
            agent_models=agent_models,
        )


def _extract_dispatched_agents(result: Dict[str, Any]) -> list[str]:
    """从结果消息中提取参与的 Agent slug 列表。"""
    slugs = []
    for msg in result.get("messages", []):
        slug = msg.get("agent_slug")
        if slug and slug not in ("dispatcher", "system") and slug not in slugs:
            slugs.append(slug)
    return slugs


def _extract_summary(result: Dict[str, Any]) -> Optional[str]:
    """提取最终摘要：优先 summary 类型消息，否则取最后一条 agent 回复。"""
    messages = result.get("messages", [])
    for msg in reversed(messages):
        if msg.get("message_type") == "summary":
            return msg.get("content")
    for msg in reversed(messages):
        if msg.get("role") in ("agent", "dispatcher") and msg.get("message_type") == "response":
            return msg.get("content")
    return None


def _extract_usage(result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """汇总所有消息中的 token 用量。"""
    total = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    found = False
    for msg in result.get("messages", []):
        usage = msg.get("usage")
        if usage and isinstance(usage, dict):
            found = True
            for k in total:
                total[k] += usage.get(k, 0)
    return total if found else None


async def _send_callback(job_id: str, callback_url: str) -> None:
    """Job 完成后向 callback_url POST 结果。"""
    from app.store import store

    job = store.get_job(job_id)
    if job is None:
        return

    payload = {
        "job_id": job.job_id,
        "status": job.status,
        "summary": job.summary,
        "result": job.result,
        "error": job.error,
        "usage": job.usage,
        "duration_ms": job.duration_ms,
    }

    try:
        async with httpx.AsyncClient(timeout=settings.job_callback_timeout) as client:
            resp = await client.post(callback_url, json=payload)
            log.info("Job %s 回调 %s → %d", job_id, callback_url, resp.status_code)
    except Exception as e:
        log.warning("Job %s 回调失败: %s", job_id, e)
