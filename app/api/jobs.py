"""Job API — 外部系统（如 OpenClaw）对接入口。"""
from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.models import ApiEnvelope, JobCreateRequest, JobRecord, make_id
from app.services.job_executor import run_job
from app.store import store

log = logging.getLogger(__name__)

router = APIRouter()


def _envelope(trace_id: str, data: dict, error: Optional[str] = None) -> ApiEnvelope:
    return ApiEnvelope(trace_id=trace_id, request_id=make_id("req"), data=data, error=error)


# ----------------------------------------------------------------
# POST /  — 提交任务（异步）
# ----------------------------------------------------------------

@router.post("")
async def create_job(payload: JobCreateRequest, background_tasks: BackgroundTasks) -> ApiEnvelope:
    """提交任务，立即返回 job_id，后台异步执行。"""
    trace_id = make_id("trc")
    job_id = make_id("job")

    job = JobRecord(
        job_id=job_id,
        task=payload.task,
        context=payload.context,
        agent_slug=payload.agent_slug,
        callback_url=payload.callback_url,
        priority=payload.priority,
        timeout_seconds=payload.timeout_seconds,
    )
    store.put_job(job)

    background_tasks.add_task(
        run_job,
        job_id=job_id,
        task=payload.task,
        context=payload.context,
        agent_slug=payload.agent_slug,
        callback_url=payload.callback_url,
        timeout_seconds=payload.timeout_seconds,
    )

    log.info("Job %s 已创建 (agent=%s, timeout=%ds)", job_id, payload.agent_slug, payload.timeout_seconds)

    return _envelope(
        trace_id=trace_id,
        data={"job_id": job_id, "status": "pending"},
    )


# ----------------------------------------------------------------
# POST /stream  — 提交任务（SSE 流式）
# ----------------------------------------------------------------

@router.post("/stream")
async def create_job_stream(payload: JobCreateRequest):
    """提交任务，SSE 流式返回执行进度和结果。"""
    job_id = make_id("job")

    job = JobRecord(
        job_id=job_id,
        task=payload.task,
        context=payload.context,
        agent_slug=payload.agent_slug,
        callback_url=payload.callback_url,
        priority=payload.priority,
        timeout_seconds=payload.timeout_seconds,
    )
    store.put_job(job)

    async def event_generator():
        import asyncio
        import time
        from app.models import now_iso

        yield f"event: init\ndata: {json.dumps({'job_id': job_id})}\n\n"

        store.update_job(job_id, status="running")
        t0 = time.monotonic()

        try:
            user_message = payload.task
            if payload.context:
                user_message += f"\n\n附加上下文：{payload.context}"

            agent_models = {}
            try:
                from app.office.store import office_store
                if office_store is not None:
                    agent_models = office_store.get_agent_model_configs()
            except Exception:
                pass

            if payload.agent_slug:
                from app.services.agents.registry import load_agent_registry
                from app.services.agents.runner import run_agent_stream

                registry = load_agent_registry()
                agent_defn = registry.get(payload.agent_slug, {})
                if not agent_defn:
                    yield f"event: error\ndata: {json.dumps({'error': f'未找到 Agent: {payload.agent_slug}'})}\n\n"
                    return

                target_model = None
                target_api_base = None
                target_api_key = None
                if agent_models and payload.agent_slug in agent_models:
                    ac = agent_models[payload.agent_slug]
                    target_model = ac.get("model_name") or None
                    target_api_base = ac.get("api_base") or None
                    target_api_key = ac.get("api_key") or None
                target_model = target_model or agent_defn.get("model_name")

                async for event in run_agent_stream(
                    agent_slug=payload.agent_slug,
                    agent_defn=agent_defn,
                    user_message=user_message,
                    task_summary=payload.task,
                    model=target_model,
                    api_base=target_api_base,
                    api_key=target_api_key,
                ):
                    event_type = event.get("event", "message")
                    event_data = event.get("data", {})
                    yield f"event: {event_type}\ndata: {json.dumps(event_data, ensure_ascii=False)}\n\n"
            else:
                from app.services.agents.dispatcher import dispatch_stream

                dispatcher_cfg = agent_models.get("dispatcher", {})
                dispatcher_model = dispatcher_cfg.get("model_name") if dispatcher_cfg else None

                async for event in dispatch_stream(
                    user_message=user_message,
                    dispatcher_model=dispatcher_model,
                    agent_models=agent_models,
                ):
                    event_type = event.get("event", "message")
                    event_data = event.get("data", {})
                    yield f"event: {event_type}\ndata: {json.dumps(event_data, ensure_ascii=False)}\n\n"

            duration_ms = int((time.monotonic() - t0) * 1000)
            store.update_job(job_id, status="succeeded", duration_ms=duration_ms, updated_at=now_iso())

            yield f"event: done\ndata: {json.dumps({'job_id': job_id, 'duration_ms': duration_ms})}\n\n"

        except Exception as e:
            duration_ms = int((time.monotonic() - t0) * 1000)
            log.exception("Job stream %s 异常", job_id)
            store.update_job(
                job_id, status="failed", error=str(e)[:500],
                duration_ms=duration_ms, updated_at=now_iso(),
            )
            yield f"event: error\ndata: {json.dumps({'error': str(e)[:200]}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ----------------------------------------------------------------
# GET /{job_id}  — 查询任务状态和结果
# ----------------------------------------------------------------

@router.get("/{job_id}")
async def get_job(job_id: str) -> ApiEnvelope:
    """查询 Job 状态和结果。"""
    job = store.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    return _envelope(
        trace_id=make_id("trc"),
        data=job.model_dump(),
    )


# ----------------------------------------------------------------
# GET /  — 任务列表
# ----------------------------------------------------------------

@router.get("")
async def list_jobs(
    status: Optional[str] = Query(default=None, description="按状态过滤"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100, alias="pageSize"),
) -> ApiEnvelope:
    """查询 Job 列表，支持分页和状态过滤。"""
    result = store.list_jobs(status=status, page=page, page_size=page_size)

    return _envelope(
        trace_id=make_id("trc"),
        data={
            "jobs": [j.model_dump() for j in result["jobs"]],
            "total": result["total"],
            "page": page,
            "pageSize": page_size,
        },
    )
