"""
Model provider for every agent: Google Gemini, Anthropic Claude, or a local model served
over an OpenAI-compatible API (LM Studio, llama.cpp server, Ollama).

LLM_PROVIDER picks one ("gemini", "anthropic" or "local"); without it, Gemini is used when
GEMINI_API_KEY is set, otherwise Claude. Everything above this layer (tools, rules,
guideline gate, SSE events) is provider-independent.
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, AsyncIterator, Literal, Optional

import httpx
from anthropic import AsyncAnthropic
from pydantic import BaseModel

Provider = Literal["gemini", "anthropic", "local"]

# Claude
MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-5-5")
# Refusal fallback: if a safety classifier declines, the API re-runs the request on
# Anthropic's recommended fallback model instead of returning a refusal.
FALLBACK = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}

# Gemini. Flash fits the free tier's rate limits; an agent turn makes several calls.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
# One-shot calls (document reading, pipeline extraction) move to the next model when one is
# out of quota. Chat doesn't: a conversation's thinking signatures belong to one model.
GEMINI_FALLBACK_MODELS = [m.strip() for m in os.getenv("GEMINI_FALLBACK_MODELS", "gemini-3-flash-preview,gemini-flash-latest").split(",") if m.strip()]

# Local: LM Studio's server by default, reached from the containers through the host.
LOCAL_LLM_URL = os.getenv("LOCAL_LLM_URL", "http://host.docker.internal:1234/v1").rstrip("/")
LOCAL_LLM_MODEL = os.getenv("LOCAL_LLM_MODEL", "qwen3-4b-instruct-2507")
# The chat agent needs reliable tool calling, which vision models often lack: it can use its own model.
LOCAL_LLM_CHAT_MODEL = os.getenv("LOCAL_LLM_CHAT_MODEL") or LOCAL_LLM_MODEL
LOCAL_TIMEOUT = httpx.Timeout(float(os.getenv("LOCAL_LLM_TIMEOUT_S", "300")), connect=5)

_anthropic: Optional[AsyncAnthropic] = None
_gemini = None


class NotConfigured(RuntimeError):
    pass


def provider() -> Provider:
    chosen = os.getenv("LLM_PROVIDER", "").strip().lower()
    if chosen in ("gemini", "anthropic", "local"):
        return chosen  # type: ignore[return-value]
    return "gemini" if os.getenv("GEMINI_API_KEY") else "anthropic"


def model_name() -> str:
    return {"gemini": GEMINI_MODEL, "local": LOCAL_LLM_MODEL}.get(provider(), MODEL)


def check_configured() -> None:
    """Raise NotConfigured if the active provider can't be used."""
    p = provider()
    if p == "gemini":
        gemini()
    elif p == "anthropic":
        client()


def client() -> AsyncAnthropic:
    global _anthropic
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise NotConfigured("The AI assistant isn’t configured on the server (ANTHROPIC_API_KEY).")
    if _anthropic is None:
        _anthropic = AsyncAnthropic()
    return _anthropic


def gemini():
    """google.genai client; use its .aio namespace for async calls."""
    global _gemini
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise NotConfigured("The AI assistant isn’t configured on the server (GEMINI_API_KEY).")
    if _gemini is None:
        from google import genai

        _gemini = genai.Client(api_key=key)
    return _gemini


def _quota_exhausted(e: Exception) -> bool:
    from google.genai import errors as gerrors

    return isinstance(e, gerrors.APIError) and (e.code == 429 or (e.status or "").upper() == "RESOURCE_EXHAUSTED")


OVERLOAD_RETRY_S = 8


def _overloaded(e: Exception) -> bool:
    from google.genai import errors as gerrors

    return isinstance(e, gerrors.APIError) and (e.code in (500, 503) or (e.status or "").upper() in ("UNAVAILABLE", "INTERNAL"))


async def gemini_generate(contents, config, model: Optional[str] = None):
    """generate_content with quota fallback across GEMINI_FALLBACK_MODELS. Returns (response, model used)."""
    models = [model or GEMINI_MODEL] + [m for m in GEMINI_FALLBACK_MODELS if m != (model or GEMINI_MODEL)]
    last: Optional[Exception] = None
    for m in models:
        for attempt in range(2):
            try:
                return await gemini().aio.models.generate_content(model=m, contents=contents, config=config), m
            except Exception as e:
                last = e
                if _overloaded(e) and attempt == 0:
                    await asyncio.sleep(OVERLOAD_RETRY_S)  # usually a short demand spike: retry once
                    continue
                if _quota_exhausted(e) or _overloaded(e):
                    break  # next model
                raise
    raise last  # every model is out of quota or overloaded


class LocalError(RuntimeError):
    def __init__(self, status: Optional[int], message: str):
        super().__init__(message)
        self.status, self.message = status, message


def _local_headers() -> dict:
    key = os.getenv("LOCAL_LLM_API_KEY")  # only if the server requires one
    return {"Authorization": f"Bearer {key}"} if key else {}


def _local_error(r: httpx.Response) -> LocalError:
    try:
        err = r.json().get("error")
        msg = err.get("message") if isinstance(err, dict) else str(err)
    except ValueError:
        msg = r.text[:300]
    return LocalError(r.status_code, msg or f"HTTP {r.status_code}")


async def local_complete(messages: list[dict], **params: Any) -> dict:
    """One non-streaming chat completion; returns choices[0]."""
    async with httpx.AsyncClient(timeout=LOCAL_TIMEOUT) as http:
        try:
            r = await http.post(f"{LOCAL_LLM_URL}/chat/completions", headers=_local_headers(),
                                json={"model": LOCAL_LLM_MODEL, "messages": messages, **params})
        except httpx.HTTPError as e:
            raise LocalError(None, str(e) or type(e).__name__) from e
    if r.status_code != 200:
        raise _local_error(r)
    return r.json()["choices"][0]


async def local_stream(messages: list[dict], model: Optional[str] = None, **params: Any) -> AsyncIterator[dict]:
    """Streamed chat completion; yields each chunk's choices[0]."""
    async with httpx.AsyncClient(timeout=LOCAL_TIMEOUT) as http:
        try:
            async with http.stream("POST", f"{LOCAL_LLM_URL}/chat/completions", headers=_local_headers(),
                                   json={"model": model or LOCAL_LLM_MODEL, "messages": messages, "stream": True, **params}) as r:
                if r.status_code != 200:
                    await r.aread()
                    raise _local_error(r)
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        return
                    chunk = json.loads(data)
                    if chunk.get("error"):
                        raise LocalError(None, str(chunk["error"]))
                    if chunk.get("choices"):
                        yield chunk["choices"][0]
        except httpx.HTTPError as e:
            raise LocalError(None, str(e) or type(e).__name__) from e


async def local_json(messages: list[dict], schema: type[BaseModel]) -> BaseModel:
    """A completion constrained to the schema (the server enforces it with a grammar)."""
    choice = await local_complete(messages, temperature=0, response_format={
        "type": "json_schema",
        "json_schema": {"name": schema.__name__, "strict": True, "schema": schema.model_json_schema()},
    })
    if choice.get("finish_reason") == "length":
        raise LocalError(None, "the answer was cut off (the model's context or output limit)")
    return schema.model_validate_json(choice["message"].get("content") or "")


def describe_error(e: Exception) -> str:
    """A message the user can act on, for errors from any provider."""
    import anthropic
    from google.genai import errors as gerrors

    if isinstance(e, LocalError):
        if e.status is None:
            return "Couldn’t reach the local AI model. Check that LM Studio’s server is running and a model is loaded."
        if e.status in (401, 403):
            return "The local AI server rejected the request. Check LOCAL_LLM_API_KEY."
        if e.status == 404 or ("model" in e.message.lower() and "not" in e.message.lower()):
            return f"The local AI server doesn’t have the model “{LOCAL_LLM_MODEL}” loaded. Load it in LM Studio or set LOCAL_LLM_MODEL."
        if "context" in e.message.lower():
            return "This conversation is too long for the local model’s context. Start a new one."
        return "The local AI model had a problem answering. Try again."

    if isinstance(e, gerrors.APIError):
        status = (e.status or "").upper()
        if e.code in (401, 403) or status in ("UNAUTHENTICATED", "PERMISSION_DENIED"):
            return "The AI service rejected the server’s API key. Check GEMINI_API_KEY."
        if e.code == 429 or status == "RESOURCE_EXHAUSTED":
            return "The AI service quota is used up for now (free-tier limits). Wait a minute and try again."
        if e.code == 404:
            return f"The AI model “{GEMINI_MODEL}” isn’t available for this key. Set GEMINI_MODEL to one it can use."
        if isinstance(e, gerrors.ServerError):
            return "The AI service had an error. Try again in a moment."
        return "The assistant had a problem answering. Try again."

    msg = getattr(e, "message", "") or str(e)
    if isinstance(e, anthropic.AuthenticationError):
        return "The AI service rejected the server’s API key. Check ANTHROPIC_API_KEY."
    if isinstance(e, anthropic.PermissionDeniedError):
        return "The server’s API key isn’t allowed to use this model."
    if isinstance(e, anthropic.BadRequestError) and "credit balance" in msg.lower():
        return "The AI service account is out of credits. Add credits in the Claude Console (Plans & Billing), then try again."
    if isinstance(e, anthropic.RateLimitError):
        return "The assistant is busy right now. Try again in a minute."
    if isinstance(e, anthropic.APIConnectionError):
        return "Couldn’t reach the AI service. Try again in a moment."
    if isinstance(e, anthropic.InternalServerError):
        return "The AI service had an error. Try again in a moment."
    return "The assistant had a problem answering. Try again."
