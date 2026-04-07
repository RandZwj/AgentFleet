"""调度员 — 理解用户意图，路由到合适的 Agent 执行。"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, AsyncGenerator, Dict, List, Optional

from app.services.llm_service import async_chat_completion
from app.services.agents.registry import (
    build_dispatcher_prompt,
    build_dispatcher_tools,
    load_agent_registry,
)
from app.services.agents.runner import record_cost, run_agent, run_agent_stream

log = logging.getLogger(__name__)

_SENTINEL = object()


async def dispatch(
    user_message: str,
    conversation_history: Optional[List[Dict[str, str]]] = None,
    dispatcher_model: Optional[str] = None,
    agent_model: Optional[str] = None,
    agent_models: Optional[Dict[str, Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """执行完整的调度流程（异步）：用户消息 → 调度员路由 → Agent 执行。"""
    from app.models import make_id

    trace_id = make_id("trc")
    result_messages: List[Dict[str, Any]] = []

    # 动态加载 Agent 注册表
    registry = load_agent_registry()

    # 构建调度员消息（动态生成）
    dispatcher_prompt = build_dispatcher_prompt(registry)
    dispatcher_tools = build_dispatcher_tools(registry)

    messages = [{"role": "system", "content": dispatcher_prompt}]
    if conversation_history:
        messages.extend(conversation_history)
    messages.append({"role": "user", "content": user_message})

    # 调度员自身的代理配置
    dispatcher_api_base = None
    dispatcher_api_key = None
    if agent_models and "dispatcher" in agent_models:
        dc = agent_models["dispatcher"]
        dispatcher_model = dispatcher_model or dc.get("model_name") or None
        dispatcher_api_base = dc.get("api_base") or None
        dispatcher_api_key = dc.get("api_key") or None

    # 调用调度员 LLM
    t0 = time.monotonic()
    dispatcher_result = await async_chat_completion(
        messages=messages,
        model=dispatcher_model,
        temperature=0.3,
        tools=dispatcher_tools,
        api_base=dispatcher_api_base,
        api_key=dispatcher_api_key,
    )
    dispatcher_ms = int((time.monotonic() - t0) * 1000)

    record_cost(
        agent_slug="dispatcher",
        trace_id=trace_id,
        model_name=dispatcher_result.get("model", dispatcher_model or "unknown"),
        usage=dispatcher_result["usage"],
        duration_ms=dispatcher_ms,
    )

    # 处理调度员响应
    tool_calls = dispatcher_result.get("tool_calls")

    if tool_calls:
        for tc in tool_calls:
            func = tc.get("function", {})
            func_name = func.get("name", "")

            if func_name == "trigger_skill":
                # LLM 直接判断应触发 Skill
                from app.services.skills.engine import SkillEngine

                args = json.loads(func.get("arguments", "{}"))
                skill_name = args.get("skill_name", "")
                query = args.get("query", user_message)

                log.info("LLM Skill 触发: %s (query=%s)", skill_name, query)

                result_messages.append({
                    "role": "dispatcher",
                    "agent_slug": "dispatcher",
                    "agent_name": "调度员",
                    "content": f"收到，我来启动{skill_name}技能帮你处理。",
                    "usage": dispatcher_result["usage"],
                    "message_type": "routing",
                    "movement": {"agent_id": "agt_dispatcher", "room_id": "manager"},
                })

                # 找到 Skill 关联的 Agent slug（用于前端展示）
                from app.services.skills.registry import get_skill
                skill_obj = get_skill(skill_name)
                agent_slug_for_skill = (
                    skill_obj.agent_slugs[0] if skill_obj and skill_obj.agent_slugs else "shopping_guide"
                )

                skill_events = []
                async for event in SkillEngine.start_skill(
                    skill_name=skill_name,
                    agent_slug=agent_slug_for_skill,
                    params={"query": query},
                ):
                    skill_events.append(event)

                for evt in skill_events:
                    result_messages.append({
                        "role": "skill",
                        "agent_slug": agent_slug_for_skill,
                        "agent_name": skill_obj.display_name if skill_obj else skill_name,
                        "content": evt["data"].get("content", ""),
                        "message_type": evt["event"],
                        "skill_data": evt["data"],
                    })

            elif func_name == "assign_task":
                args = json.loads(func.get("arguments", "{}"))
                agent_slug = args.get("agent_slug", "shopping_guide")
                task_summary = args.get("task_summary", user_message)

                # 从注册表获取 Agent 信息
                agent_defn = registry.get(agent_slug, {})
                target_name = agent_defn.get("display_name", agent_slug)

                result_messages.append({
                    "role": "dispatcher",
                    "agent_slug": "dispatcher",
                    "agent_name": "调度员",
                    "content": f"收到，这个需求交给{target_name}处理。",
                    "usage": dispatcher_result["usage"],
                    "message_type": "routing",
                    "movement": {"agent_id": "agt_dispatcher", "room_id": "manager"},
                })

                # 确定目标模型和代理配置：per-agent 配置 > 全局 agent_model
                target_model = None
                target_api_base = None
                target_api_key = None
                if agent_models and agent_slug in agent_models:
                    ac = agent_models[agent_slug]
                    target_model = ac.get("model_name") or None
                    target_api_base = ac.get("api_base") or None
                    target_api_key = ac.get("api_key") or None
                target_model = target_model or agent_defn.get("model_name") or agent_model

                agent_response = await run_agent(
                    agent_slug=agent_slug,
                    agent_defn=agent_defn,
                    user_message=user_message,
                    task_summary=task_summary,
                    conversation_history=conversation_history,
                    model=target_model,
                    api_base=target_api_base,
                    api_key=target_api_key,
                )
                result_messages.extend(agent_response["messages"])

            elif func_name == "dispatch_plan":
                args = json.loads(func.get("arguments", "{}"))
                async for event in _execute_task_dag(
                    plan=args,
                    registry=registry,
                    user_message=user_message,
                    conversation_history=conversation_history,
                    dispatcher_usage=dispatcher_result["usage"],
                    agent_model=agent_model,
                    agent_models=agent_models,
                    dispatcher_model=dispatcher_model,
                    dispatcher_api_base=dispatcher_api_base,
                    dispatcher_api_key=dispatcher_api_key,
                ):
                    if event.get("event") in ("routing", "process", "message"):
                        result_messages.append(event.get("data", {}))
    else:
        result_messages.append({
            "role": "dispatcher",
            "agent_slug": "dispatcher",
            "agent_name": "调度员",
            "content": dispatcher_result["content"],
            "usage": dispatcher_result["usage"],
            "message_type": "response",
            "movement": None,
        })

    agent_movements = [
        msg["movement"] for msg in result_messages
        if msg.get("movement")
    ]

    return {
        "messages": result_messages,
        "agent_movements": agent_movements,
    }


async def dispatch_stream(
    user_message: str,
    conversation_history: Optional[List[Dict[str, str]]] = None,
    dispatcher_model: Optional[str] = None,
    agent_model: Optional[str] = None,
    agent_models: Optional[Dict[str, Dict[str, str]]] = None,
) -> AsyncGenerator[Dict[str, Any], None]:
    """SSE 版调度流程：yield 事件 dict，每个阶段实时推送给前端。"""
    from app.models import make_id

    trace_id = make_id("trc")

    registry = load_agent_registry()
    dispatcher_prompt = build_dispatcher_prompt(registry)
    dispatcher_tools = build_dispatcher_tools(registry)

    messages = [{"role": "system", "content": dispatcher_prompt}]
    if conversation_history:
        messages.extend(conversation_history)
    messages.append({"role": "user", "content": user_message})

    dispatcher_api_base = None
    dispatcher_api_key = None
    if agent_models and "dispatcher" in agent_models:
        dc = agent_models["dispatcher"]
        dispatcher_model = dispatcher_model or dc.get("model_name") or None
        dispatcher_api_base = dc.get("api_base") or None
        dispatcher_api_key = dc.get("api_key") or None

    t0 = time.monotonic()
    dispatcher_result = await async_chat_completion(
        messages=messages,
        model=dispatcher_model,
        temperature=0.3,
        tools=dispatcher_tools,
        api_base=dispatcher_api_base,
        api_key=dispatcher_api_key,
    )
    dispatcher_ms = int((time.monotonic() - t0) * 1000)

    record_cost(
        agent_slug="dispatcher",
        trace_id=trace_id,
        model_name=dispatcher_result.get("model", dispatcher_model or "unknown"),
        usage=dispatcher_result["usage"],
        duration_ms=dispatcher_ms,
    )

    tool_calls = dispatcher_result.get("tool_calls")

    if tool_calls:
        tool_names = [tc.get("function", {}).get("name") for tc in tool_calls]
        log.info("[调度员-stream] 返回 %d 个 tool_calls: %s", len(tool_calls), tool_names)

        # 兜底：多个 assign_task 自动升级为并行 DAG
        assign_calls = [
            tc for tc in tool_calls
            if tc.get("function", {}).get("name") == "assign_task"
        ]
        if len(assign_calls) >= 2:
            log.info("[调度员-stream] 检测到 %d 个 assign_task，自动升级为并行 DAG", len(assign_calls))
            auto_tasks = []
            for i, tc in enumerate(assign_calls):
                args = json.loads(tc.get("function", {}).get("arguments", "{}"))
                auto_tasks.append({
                    "task_id": f"task_{i + 1}",
                    "agent_slug": args.get("agent_slug", ""),
                    "task_summary": args.get("task_summary", user_message),
                    "depends_on": [],
                })
            auto_plan = {
                "summary": "多 Agent 并行协作",
                "tasks": auto_tasks,
            }
            async for event in _execute_task_dag(
                plan=auto_plan,
                registry=registry,
                user_message=user_message,
                conversation_history=conversation_history,
                dispatcher_usage=dispatcher_result["usage"],
                agent_model=agent_model,
                agent_models=agent_models,
                dispatcher_model=dispatcher_model,
                dispatcher_api_base=dispatcher_api_base,
                dispatcher_api_key=dispatcher_api_key,
            ):
                yield event

            # 处理剩余的非 assign_task 调用（如 trigger_skill）
            for tc in tool_calls:
                func = tc.get("function", {})
                func_name = func.get("name", "")
                if func_name == "assign_task":
                    continue

                if func_name == "trigger_skill":
                    from app.services.skills.engine import SkillEngine
                    args = json.loads(func.get("arguments", "{}"))
                    skill_name = args.get("skill_name", "")
                    query = args.get("query", user_message)
                    log.info("LLM Skill 触发 (stream): %s (query=%s)", skill_name, query)
                    from app.services.skills.registry import get_skill
                    skill_obj = get_skill(skill_name)
                    agent_slug_for_skill = (
                        skill_obj.agent_slugs[0] if skill_obj and skill_obj.agent_slugs else "shopping_guide"
                    )
                    yield {
                        "event": "routing",
                        "data": {
                            "role": "dispatcher", "agent_slug": "dispatcher", "agent_name": "调度员",
                            "content": f"收到，我来启动{skill_name}技能帮你处理。",
                            "usage": dispatcher_result["usage"], "message_type": "routing",
                            "movement": {"agent_id": "agt_dispatcher", "room_id": "manager"},
                        },
                    }
                    async for event in SkillEngine.start_skill(
                        skill_name=skill_name, agent_slug=agent_slug_for_skill, params={"query": query},
                    ):
                        yield event

                elif func_name == "dispatch_plan":
                    args = json.loads(func.get("arguments", "{}"))
                    async for event in _execute_task_dag(
                        plan=args, registry=registry, user_message=user_message,
                        conversation_history=conversation_history,
                        dispatcher_usage=dispatcher_result["usage"],
                        agent_model=agent_model, agent_models=agent_models,
                        dispatcher_model=dispatcher_model,
                        dispatcher_api_base=dispatcher_api_base,
                        dispatcher_api_key=dispatcher_api_key,
                    ):
                        yield event
        else:
            # 单个 assign_task 或其他工具：按原有逻辑串行处理
            for tc in tool_calls:
                func = tc.get("function", {})
                func_name = func.get("name", "")

                if func_name == "trigger_skill":
                    from app.services.skills.engine import SkillEngine

                    args = json.loads(func.get("arguments", "{}"))
                    skill_name = args.get("skill_name", "")
                    query = args.get("query", user_message)

                    log.info("LLM Skill 触发 (stream): %s (query=%s)", skill_name, query)

                    from app.services.skills.registry import get_skill
                    skill_obj = get_skill(skill_name)
                    agent_slug_for_skill = (
                        skill_obj.agent_slugs[0] if skill_obj and skill_obj.agent_slugs else "shopping_guide"
                    )

                    yield {
                        "event": "routing",
                        "data": {
                            "role": "dispatcher",
                            "agent_slug": "dispatcher",
                            "agent_name": "调度员",
                            "content": f"收到，我来启动{skill_name}技能帮你处理。",
                            "usage": dispatcher_result["usage"],
                            "message_type": "routing",
                            "movement": {"agent_id": "agt_dispatcher", "room_id": "manager"},
                        },
                    }

                    async for event in SkillEngine.start_skill(
                        skill_name=skill_name,
                        agent_slug=agent_slug_for_skill,
                        params={"query": query},
                    ):
                        yield event

                elif func_name == "assign_task":
                    args = json.loads(func.get("arguments", "{}"))
                    agent_slug = args.get("agent_slug", "shopping_guide")
                    task_summary = args.get("task_summary", user_message)

                    agent_defn = registry.get(agent_slug, {})
                    target_name = agent_defn.get("display_name", agent_slug)

                    yield {
                        "event": "routing",
                        "data": {
                            "role": "dispatcher",
                            "agent_slug": "dispatcher",
                            "agent_name": "调度员",
                            "content": f"收到，这个需求交给{target_name}处理。",
                            "usage": dispatcher_result["usage"],
                            "message_type": "routing",
                            "movement": {"agent_id": "agt_dispatcher", "room_id": "manager"},
                        },
                    }

                    target_model = None
                    target_api_base = None
                    target_api_key = None
                    if agent_models and agent_slug in agent_models:
                        ac = agent_models[agent_slug]
                        target_model = ac.get("model_name") or None
                        target_api_base = ac.get("api_base") or None
                        target_api_key = ac.get("api_key") or None
                    target_model = target_model or agent_defn.get("model_name") or agent_model

                    async for event in run_agent_stream(
                        agent_slug=agent_slug,
                        agent_defn=agent_defn,
                        user_message=user_message,
                        task_summary=task_summary,
                        conversation_history=conversation_history,
                        model=target_model,
                        api_base=target_api_base,
                        api_key=target_api_key,
                    ):
                        yield event

                elif func_name == "dispatch_plan":
                    args = json.loads(func.get("arguments", "{}"))
                    async for event in _execute_task_dag(
                        plan=args,
                        registry=registry,
                        user_message=user_message,
                        conversation_history=conversation_history,
                        dispatcher_usage=dispatcher_result["usage"],
                        agent_model=agent_model,
                        agent_models=agent_models,
                        dispatcher_model=dispatcher_model,
                        dispatcher_api_base=dispatcher_api_base,
                        dispatcher_api_key=dispatcher_api_key,
                    ):
                        yield event
    else:
        yield {
            "event": "message",
            "data": {
                "role": "dispatcher",
                "agent_slug": "dispatcher",
                "agent_name": "调度员",
                "content": dispatcher_result["content"],
                "usage": dispatcher_result["usage"],
                "message_type": "response",
                "movement": None,
            },
        }

    yield {"event": "done", "data": {"trace_id": trace_id}}


# ============================================================
# DAG 任务执行引擎 — dispatch_plan 的核心实现
# ============================================================

async def _generate_summary(
    user_message: str,
    task_agents: Dict[str, str],
    completed: Dict[str, str],
    dispatcher_model: Optional[str] = None,
    dispatcher_api_base: Optional[str] = None,
    dispatcher_api_key: Optional[str] = None,
) -> AsyncGenerator[Dict[str, Any], None]:
    """所有 Agent 完成后，调度者汇总各方结果并输出总结。"""
    results_text = "\n\n".join(
        f"### {task_agents.get(tid, tid)} 的结果\n{content[:1500]}"
        for tid, content in completed.items()
    )

    summary_prompt = f"""你是 AgentsOffice 的调度员。刚才用户提出了一个需求，你将其拆分给多个 Agent 并行/串行完成。
现在所有 Agent 都已完成工作，请你基于各 Agent 的结果做一个简洁的**汇总总结**。

要求：
1. 用 2-4 句话概括全部产出
2. 突出关键成果和亮点
3. 如果有 Agent 生成了图片链接，保留原始 Markdown 图片格式
4. 语气专业友好

## 用户原始需求
{user_message}

## 各 Agent 产出
{results_text}"""

    try:
        t0 = time.monotonic()
        summary_result = await async_chat_completion(
            messages=[{"role": "user", "content": summary_prompt}],
            model=dispatcher_model,
            temperature=0.4,
            api_base=dispatcher_api_base,
            api_key=dispatcher_api_key,
        )
        summary_ms = int((time.monotonic() - t0) * 1000)

        record_cost(
            agent_slug="dispatcher",
            trace_id="summary",
            model_name=summary_result.get("model", dispatcher_model or "unknown"),
            usage=summary_result.get("usage", {}),
            duration_ms=summary_ms,
        )

        summary_content = summary_result.get("content", "")
        if summary_content:
            yield {
                "event": "message",
                "data": {
                    "role": "dispatcher",
                    "agent_slug": "dispatcher",
                    "agent_name": "调度员",
                    "content": summary_content,
                    "usage": summary_result.get("usage", {}),
                    "message_type": "summary",
                    "movement": None,
                },
            }
    except Exception as e:
        log.warning("生成汇总摘要失败: %s", e)


def _resolve_agent_config(
    agent_slug: str,
    registry: Dict[str, Any],
    agent_model: Optional[str],
    agent_models: Optional[Dict[str, Dict[str, str]]],
) -> tuple:
    """解析单个 Agent 的模型/代理配置。"""
    agent_defn = registry.get(agent_slug, {})
    target_model = None
    target_api_base = None
    target_api_key = None
    if agent_models and agent_slug in agent_models:
        ac = agent_models[agent_slug]
        target_model = ac.get("model_name") or None
        target_api_base = ac.get("api_base") or None
        target_api_key = ac.get("api_key") or None
    target_model = target_model or agent_defn.get("model_name") or agent_model
    return agent_defn, target_model, target_api_base, target_api_key


async def _run_agent_to_queue(
    queue: asyncio.Queue,
    task_id: str,
    agent_slug: str,
    agent_defn: Dict[str, Any],
    user_message: str,
    task_summary: str,
    conversation_history: Optional[List[Dict[str, str]]],
    model: Optional[str],
    api_base: Optional[str],
    api_key: Optional[str],
) -> str:
    """运行单个 Agent 并将 SSE 事件推送到共享队列，返回最终回复内容。"""
    final_content = ""
    try:
        async for event in run_agent_stream(
            agent_slug=agent_slug,
            agent_defn=agent_defn,
            user_message=user_message,
            task_summary=task_summary,
            conversation_history=conversation_history,
            model=model,
            api_base=api_base,
            api_key=api_key,
        ):
            # 注入 task_id 到事件中
            if "data" in event:
                event["data"]["task_id"] = task_id
            await queue.put(event)
            if event.get("event") == "message" and event.get("data", {}).get("content"):
                final_content = event["data"]["content"]
    except Exception as e:
        log.error("DAG 任务 %s (%s) 执行异常: %s", task_id, agent_slug, e)
        await queue.put({
            "event": "message",
            "data": {
                "role": "agent",
                "agent_slug": agent_slug,
                "agent_name": agent_defn.get("display_name", agent_slug),
                "content": f"抱歉，任务执行出错：{e}",
                "message_type": "response",
                "task_id": task_id,
                "movement": None,
            },
        })
    return final_content


async def _execute_task_dag(
    plan: Dict[str, Any],
    registry: Dict[str, Any],
    user_message: str,
    conversation_history: Optional[List[Dict[str, str]]],
    dispatcher_usage: Dict[str, int],
    agent_model: Optional[str] = None,
    agent_models: Optional[Dict[str, Dict[str, str]]] = None,
    dispatcher_model: Optional[str] = None,
    dispatcher_api_base: Optional[str] = None,
    dispatcher_api_key: Optional[str] = None,
) -> AsyncGenerator[Dict[str, Any], None]:
    """按 DAG 依赖关系执行多个 Agent 任务，支持并行和串行混合。"""
    summary = plan.get("summary", "多 Agent 协作任务")
    tasks = plan.get("tasks", [])

    if not tasks:
        yield {
            "event": "message",
            "data": {
                "role": "dispatcher",
                "agent_slug": "dispatcher",
                "agent_name": "调度员",
                "content": summary,
                "message_type": "response",
                "movement": None,
            },
        }
        return

    # 构建任务名称映射用于展示
    task_agents = {}
    for t in tasks:
        defn = registry.get(t["agent_slug"], {})
        task_agents[t["task_id"]] = defn.get("display_name", t["agent_slug"])

    # 构建可读的并行/串行说明
    independent = [t for t in tasks if not t.get("depends_on")]
    dependent = [t for t in tasks if t.get("depends_on")]

    desc_parts = []
    if len(independent) > 1:
        names = "、".join(task_agents[t["task_id"]] for t in independent)
        desc_parts.append(f"{names} 同时开始工作")
    elif len(independent) == 1:
        desc_parts.append(f"{task_agents[independent[0]['task_id']]} 先开始")
    for t in dependent:
        dep_names = "、".join(task_agents.get(d, d) for d in t["depends_on"])
        desc_parts.append(f"{task_agents[t['task_id']]} 等待 {dep_names} 完成后再开始")

    routing_content = f"收到，这个需求需要多人协作：{'；'.join(desc_parts)}。"

    yield {
        "event": "routing",
        "data": {
            "role": "dispatcher",
            "agent_slug": "dispatcher",
            "agent_name": "调度员",
            "content": routing_content,
            "usage": dispatcher_usage,
            "message_type": "routing",
            "movement": {"agent_id": "agt_dispatcher", "room_id": "manager"},
            "parallel_info": {
                "total_tasks": len(tasks),
                "parallel_tasks": [t["task_id"] for t in independent],
                "sequential_tasks": [t["task_id"] for t in dependent],
            },
        },
    }

    # DAG 执行
    pending = {t["task_id"]: t for t in tasks}
    completed: Dict[str, str] = {}  # task_id -> final_content

    while pending:
        # 找出所有依赖已满足的任务
        ready = [
            t for t in pending.values()
            if all(dep in completed for dep in (t.get("depends_on") or []))
        ]

        if not ready:
            log.error("DAG 死锁：剩余任务 %s 均有未满足的依赖", list(pending.keys()))
            yield {
                "event": "message",
                "data": {
                    "role": "dispatcher",
                    "agent_slug": "dispatcher",
                    "agent_name": "调度员",
                    "content": "任务依赖存在循环，无法继续执行。",
                    "message_type": "response",
                    "movement": None,
                },
            }
            return

        if len(ready) == 1:
            # 单任务直接串行执行，无需队列
            task = ready[0]
            tid = task["task_id"]
            del pending[tid]

            agent_slug = task["agent_slug"]
            agent_defn, t_model, t_base, t_key = _resolve_agent_config(
                agent_slug, registry, agent_model, agent_models,
            )

            # 为有依赖的任务注入前置结果
            task_summary = task["task_summary"]
            if task.get("depends_on"):
                context = "\n".join(
                    f"[{task_agents.get(d, d)}的结果]\n{completed[d]}"
                    for d in task["depends_on"]
                )
                task_summary = f"{task_summary}\n\n## 前置任务结果（请参考）\n{context}"

            async for event in run_agent_stream(
                agent_slug=agent_slug,
                agent_defn=agent_defn,
                user_message=user_message,
                task_summary=task_summary,
                conversation_history=conversation_history,
                model=t_model,
                api_base=t_base,
                api_key=t_key,
            ):
                if "data" in event:
                    event["data"]["task_id"] = tid
                if event.get("event") == "message" and event.get("data", {}).get("content"):
                    completed[tid] = event["data"]["content"]
                yield event
        else:
            # 多任务并行执行
            queue: asyncio.Queue = asyncio.Queue()
            running_tasks: List[asyncio.Task] = []

            for task in ready:
                tid = task["task_id"]
                del pending[tid]

                agent_slug = task["agent_slug"]
                agent_defn, t_model, t_base, t_key = _resolve_agent_config(
                    agent_slug, registry, agent_model, agent_models,
                )

                task_summary = task["task_summary"]
                if task.get("depends_on"):
                    context = "\n".join(
                        f"[{task_agents.get(d, d)}的结果]\n{completed[d]}"
                        for d in task["depends_on"]
                    )
                    task_summary = f"{task_summary}\n\n## 前置任务结果（请参考）\n{context}"

                coro = _run_agent_to_queue(
                    queue=queue,
                    task_id=tid,
                    agent_slug=agent_slug,
                    agent_defn=agent_defn,
                    user_message=user_message,
                    task_summary=task_summary,
                    conversation_history=conversation_history,
                    model=t_model,
                    api_base=t_base,
                    api_key=t_key,
                )
                running_tasks.append(asyncio.create_task(coro))

            # 从队列中实时读取事件并 yield，直到所有并行任务完成
            finished_count = 0
            total = len(running_tasks)

            # 收集结果的辅助 task
            async def _gather_results():
                nonlocal finished_count
                results = await asyncio.gather(*running_tasks, return_exceptions=True)
                for i, (task_meta, result) in enumerate(zip(ready, results)):
                    tid = task_meta["task_id"]
                    if isinstance(result, str):
                        completed[tid] = result
                    elif isinstance(result, Exception):
                        completed[tid] = f"执行出错: {result}"
                    else:
                        completed[tid] = completed.get(tid, "")
                await queue.put(_SENTINEL)

            gather_task = asyncio.create_task(_gather_results())

            while True:
                item = await queue.get()
                if item is _SENTINEL:
                    break
                yield item

            await gather_task

    # ---- 汇总：≥2 个 Agent 参与时，调度者生成总结 ----
    if len(tasks) >= 2 and completed:
        async for evt in _generate_summary(
            user_message=user_message,
            task_agents=task_agents,
            completed=completed,
            dispatcher_model=dispatcher_model,
            dispatcher_api_base=dispatcher_api_base,
            dispatcher_api_key=dispatcher_api_key,
        ):
            yield evt
