"""统一图片生成服务 — 可插拔 Provider 架构。

支持多个图片生成模型，按优先级自动选择可用 Provider。
新增 Provider 只需：
1. 实现 _generate_xxx(prompt, size, style) -> dict
2. 在 _PROVIDER_CHAIN 中注册
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional

import httpx

log = logging.getLogger(__name__)

ImageResult = Dict[str, Any]
ProviderFn = Callable[[str, str, str], ImageResult]


def _size_to_aspect_ratio(size: str) -> str:
    mapping = {
        "1024x1024": "1:1",
        "1024x1536": "2:3",
        "1536x1024": "3:2",
        "1024x1792": "9:16",
        "1792x1024": "16:9",
    }
    return mapping.get(size, "1:1")


def _extract_minimax_image_url(payload: Dict[str, Any]) -> str | None:
    data = payload.get("data")
    if isinstance(data, dict):
        if data.get("image_url"):
            return data["image_url"]
        if isinstance(data.get("image_urls"), list) and data["image_urls"]:
            return data["image_urls"][0]
        if isinstance(data.get("images"), list) and data["images"]:
            first = data["images"][0]
            if isinstance(first, dict):
                return first.get("url")
    elif isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, str):
            return first
        if isinstance(first, dict):
            return first.get("url") or first.get("image_url")
    return None


# ============================================================
# Provider 实现
# ============================================================

def _generate_minimax(prompt: str, size: str, style: str) -> ImageResult:
    from app.config import settings
    if not settings.minimax_api_key:
        return {"error": "MINIMAX_API_KEY 未配置", "_skip": True}

    response = httpx.post(
        "https://api.minimaxi.com/v1/image_generation",
        headers={"Authorization": f"Bearer {settings.minimax_api_key}"},
        json={
            "model": "image-01",
            "prompt": prompt,
            "aspect_ratio": _size_to_aspect_ratio(size),
            "response_format": "url",
            "n": 1,
        },
        timeout=90.0,
    )
    response.raise_for_status()
    payload = response.json()

    base_resp = payload.get("base_resp")
    if isinstance(base_resp, dict) and base_resp.get("status_code") not in (None, 0):
        return {
            "error": f"MiniMax: {base_resp.get('status_msg', 'unknown error')}",
            "provider": "minimax",
        }

    image_url = _extract_minimax_image_url(payload)
    if image_url:
        return {
            "image_url": image_url,
            "model": "MiniMax image-01",
            "prompt_used": prompt,
            "size": size,
            "style": style,
            "provider": "minimax",
        }
    return {"error": "MiniMax 返回成功但未解析到图片地址", "provider": "minimax"}


def _generate_openai(prompt: str, size: str, style: str) -> ImageResult:
    from app.config import settings
    if not settings.openai_api_key:
        return {"error": "OPENAI_API_KEY 未配置", "_skip": True}

    import openai
    client = openai.OpenAI(api_key=settings.openai_api_key)
    response = client.images.generate(
        model="dall-e-3",
        prompt=prompt,
        size=size,
        style=style,
        n=1,
    )
    return {
        "image_url": response.data[0].url,
        "revised_prompt": response.data[0].revised_prompt,
        "model": "OpenAI dall-e-3",
        "prompt_used": prompt,
        "size": size,
        "style": style,
        "provider": "openai",
    }


# ============================================================
# Provider 注册表 — 按优先级排列
# 新增 Provider 只需在此列表中添加
# ============================================================
_PROVIDER_CHAIN: List[tuple[str, ProviderFn]] = [
    ("minimax", _generate_minimax),
    ("openai", _generate_openai),
]


# ============================================================
# 统一入口
# ============================================================

def get_available_providers() -> List[str]:
    """返回当前已配置 API Key 的可用 Provider 列表。"""
    from app.config import settings
    available = []
    key_map = {
        "minimax": settings.minimax_api_key,
        "openai": settings.openai_api_key,
    }
    for name, _ in _PROVIDER_CHAIN:
        if key_map.get(name):
            available.append(name)
    return available


def generate_image(
    prompt: str,
    size: str = "1024x1024",
    style: str = "vivid",
    provider: Optional[str] = None,
) -> ImageResult:
    """统一图片生成入口。

    Args:
        prompt: 图片描述（英文）
        size: 图片尺寸
        style: 风格
        provider: 指定 Provider 名称，为 None 时按优先级自动选择

    Returns:
        成功: {"image_url": "...", "model": "...", "provider": "...", ...}
        失败: {"error": "...", "fallback": "design_description", ...}
    """
    chain = _PROVIDER_CHAIN
    if provider:
        chain = [(n, fn) for n, fn in _PROVIDER_CHAIN if n == provider]
        if not chain:
            return {
                "error": f"未知的图片生成 Provider: {provider}",
                "fallback": "design_description",
                "prompt_used": prompt,
            }

    last_error = "未配置任何图片生成模型。请设置 MINIMAX_API_KEY 或 OPENAI_API_KEY。"

    for name, fn in chain:
        try:
            result = fn(prompt, size, style)
            if result.get("_skip"):
                continue
            if "image_url" in result:
                return result
            last_error = result.get("error", f"{name} 生成失败")
            log.warning("图片生成 Provider [%s] 失败: %s", name, last_error)
        except Exception as e:
            last_error = f"{name}: {e}"
            log.warning("图片生成 Provider [%s] 异常: %s", name, e)

    return {
        "error": last_error,
        "fallback": "design_description",
        "prompt_used": prompt,
    }
