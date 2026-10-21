"""Тонкая обёртка над Redis. Если Redis недоступен — приложение работает без кэша."""

import hashlib
import json
import logging
from typing import Any

import redis

from app.core.config import settings

log = logging.getLogger(__name__)
_client: redis.Redis | None = None


def _redis() -> redis.Redis | None:
    global _client
    if not settings.redis_url:
        return None
    if _client is None:
        _client = redis.Redis.from_url(
            settings.redis_url, socket_connect_timeout=0.5, socket_timeout=0.5, decode_responses=True
        )
    return _client


def _call(fn_name: str, *args: Any, **kwargs: Any) -> Any:
    client = _redis()
    if client is None:
        return None
    try:
        return getattr(client, fn_name)(*args, **kwargs)
    except redis.RedisError as exc:
        log.warning("redis %s failed: %s", fn_name, exc)
        return None


def version(namespace: str) -> str:
    return _call("get", f"{namespace}:version") or "0"


def bump(namespace: str) -> None:
    """Инвалидирует все ключи пространства имён, меняя его версию."""
    _call("incr", f"{namespace}:version")


def make_key(namespace: str, **parts: Any) -> str:
    digest = hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()
    return f"{namespace}:{version(namespace)}:{digest}"


def get_json(key: str) -> Any:
    raw = _call("get", key)
    return json.loads(raw) if raw else None


def set_json(key: str, value: Any, ttl: int | None = None) -> None:
    _call("set", key, json.dumps(value, default=str), ex=ttl or settings.cache_ttl_seconds)


def rate_limited(key: str, limit: int, window_seconds: int) -> bool:
    count = _call("incr", f"rl:{key}")
    if count is None:
        return False
    if count == 1:
        _call("expire", f"rl:{key}", window_seconds)
    return count > limit
