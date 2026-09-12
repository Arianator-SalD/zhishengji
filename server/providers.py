"""Real streaming adapters. No response or audio is fabricated when unconfigured.

Protocol references, checked 2026-09-12:
https://docs.volcengine.com/docs/6561/1354869?lang=zh
https://docs.volcengine.com/docs/6561/1598757?lang=zh
"""
import asyncio
import base64
import gzip
import io
import json
import struct
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlparse

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from .settings import Settings


UPSTREAM_REASONS = {
    "RESOURCE_ACCESS": "语音合成服务没有当前资源的调用权限，请核对声音复刻服务是否开通及应用是否匹配。",
    "RESOURCE_MISMATCH": "音色与语音合成模型不匹配，请核对音色 ID 和资源类型。",
    "VOICE_NOT_FOUND": "语音合成服务未找到当前音色，请核对音色 ID 及所属应用。",
    "VOICE_NOT_READY": "当前音色尚未训练完成，请先完成声音复刻。",
    "AUTH": "语音合成鉴权失败，请核对应用 ID 和 Access Token。",
    "QUOTA": "语音合成额度或并发受限，请检查服务用量。",
}


def upstream_event_error(event, http_status=None):
    # Inspect upstream text locally, expose only fixed categories, never its contents.
    text = str(event.get("message", event.get("msg", ""))).lower()
    reason = None
    if ("resource" in text and any(x in text for x in ("not granted", "permission", "not authorized", "not allowed"))):
        reason = "RESOURCE_ACCESS"
    elif any(x in text for x in ("mismatch", "invalidmodeltype", "invalid model type")):
        reason = "RESOURCE_MISMATCH"
    elif any(x in text for x in ("speaker", "voice", "音色")) and any(x in text for x in ("not found", "not exist", "不存在")):
        reason = "VOICE_NOT_FOUND"
    elif any(x in text for x in ("untrained", "not trained", "not ready", "未训练")):
        reason = "VOICE_NOT_READY"
    elif any(x in text for x in ("quota", "concurrency", "余额", "额度")):
        reason = "QUOTA"
    elif any(x in text for x in ("unauthorized", "invalid token", "invalid api key", "authentication")):
        reason = "AUTH"
    return ProviderError("upstream rejected request", upstream_code=event.get("code"),
                         http_status=http_status, reason=reason)


async def http_provider_error(response):
    body = b""
    async for chunk in response.aiter_bytes():
        body += chunk[:65536 - len(body)]
        if len(body) >= 65536:
            break
    try:
        event = json.loads(body)
        if not isinstance(event, dict):
            event = {}
    except (ValueError, UnicodeError):
        event = {}
    return upstream_event_error(event, response.status_code)


def generation_failure_details(exc, stage):
    stage = "TTS" if stage == "TTS" else "LLM"
    parts = [stage]
    message = "语音合成未完成，请检查音色设置或稍后重试。" if stage == "TTS" else "文字回答生成中断，请稍后重试。"
    status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else getattr(exc, "http_status", None)
    if type(status) is int:
        parts.append(f"HTTP_{status}")
        if stage == "TTS" and status in (401, 403):
            message = "语音合成服务拒绝访问，请核对应用凭证和服务权限。"
    if isinstance(exc, ProviderError):
        if exc.upstream_code is not None:
            parts.append(f"UPSTREAM_{exc.upstream_code}")
        if exc.reason in UPSTREAM_REASONS:
            parts.append(exc.reason)
            if stage == "TTS":
                message = UPSTREAM_REASONS[exc.reason]
    elif isinstance(exc, TimeoutError):
        parts.append("TIMEOUT")
    return {"message": message, "diagnostic": "/".join(parts)}


class ProviderError(Exception):
    """Raw upstream messages must never reach the browser."""
    def __init__(self, message, *, upstream_code=None, http_status=None, reason=None):
        super().__init__(message)
        self.upstream_code = upstream_code if type(upstream_code) is int else None
        self.http_status = http_status if type(http_status) is int else None
        self.reason = reason if reason in UPSTREAM_REASONS else None


def asr_failure_details(exc):
    """Only emit bounded status codes and fixed labels; never exception text or headers."""
    parts = []
    message = "语音识别未完成，请重新开始。"
    if isinstance(exc, InvalidStatus):
        status = exc.response.status_code
        parts.append(f"HTTP_{status}")
        code = exc.response.headers.get("X-Api-Status-Code", "")
        if code.isascii() and code.isdecimal() and len(code) <= 10:
            parts.append(f"UPSTREAM_{code}")
        if status in (401, 403):
            message = "语音识别服务拒绝访问，请核对语音 API Key、所属项目及服务开通状态。"
        elif status == 429:
            message = "语音识别服务暂时繁忙，请稍后重试。"
    elif isinstance(exc, ProviderError):
        parts.append("ASR_PROTOCOL")
        if exc.upstream_code is not None:
            parts.append(f"UPSTREAM_{exc.upstream_code}")
    elif isinstance(exc, TimeoutError):
        parts.append("ASR_TIMEOUT")
        message = "语音识别连接超时，请重新开始。"
    else:
        parts.append("ASR_CONNECTION")
    return {"message": message, "diagnostic": "/".join(parts)}


@dataclass(frozen=True)
class Transcript:
    text: str
    final: bool = False


class LLM(Protocol):
    def stream(self, messages: list[dict]) -> AsyncIterator[str]: ...


class ASR(Protocol):
    def transcribe(self, audio: AsyncIterator[bytes]) -> AsyncIterator[Transcript]: ...


class TTS(Protocol):
    sample_rate: int
    def synthesize(self, text: str) -> AsyncIterator[bytes]: ...


@dataclass
class Providers:
    llm: LLM | None = None
    asr: ASR | None = None
    tts: TTS | None = None

    @property
    def capabilities(self):
        return {name: getattr(self, name) is not None for name in ("llm", "asr", "tts")}

    @classmethod
    def configured(cls, s: Settings):
        return cls(
            OpenAIChat(s) if s.llm_url and s.llm_api_key and s.llm_model else None,
            VolcASR(s) if s.asr_url and s.asr_resource_id and (s.asr_api_key or (s.asr_app_id and s.asr_access_token)) else None,
            VolcTTS(s) if s.tts_url and s.tts_resource_id and s.tts_speaker and (s.tts_api_key or (s.tts_app_id and s.tts_access_token)) else None,
        )


async def bounded_lines(response, limit=2_000_000):
    """Decode UTF-8 lines across arbitrary TCP boundaries without unbounded buffering."""
    buffer = b""
    async for chunk in response.aiter_bytes():
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if len(line) > limit:
                raise ProviderError("oversize upstream line")
            yield line.rstrip(b"\r").decode("utf-8")
        if len(buffer) > limit:
            raise ProviderError("oversize upstream line")
    if buffer:
        yield buffer.decode("utf-8")


async def sse_data(response):
    lines = []
    size = 0
    async for line in bounded_lines(response):
        if not line:
            if lines:
                yield "\n".join(lines)
                lines, size = [], 0
        elif line.startswith("data:"):
            value = line[5:].lstrip(" ")
            size += len(value)
            if size > 2_000_000:
                raise ProviderError("oversize SSE event")
            lines.append(value)
    if lines:
        yield "\n".join(lines)


class OpenAIChat:
    def __init__(self, settings, transport=None):
        self.s, self.transport = settings, transport

    async def stream(self, messages):
        body = {"model": self.s.llm_model, "messages": messages, "stream": True,
                "max_tokens": 1200, "temperature": 0.6}
        # DeepSeek defaults to thinking enabled; voice needs the documented opt-out.
        # Other OpenAI-compatible endpoints don't receive vendor-specific fields.
        if urlparse(self.s.llm_url).hostname == "api.deepseek.com":
            body["thinking"] = {"type": "disabled"}
        async with httpx.AsyncClient(timeout=self.s.provider_timeout, transport=self.transport) as client:
            async with client.stream("POST", self.s.llm_url,
                                     headers={"Authorization": f"Bearer {self.s.llm_api_key}"},
                                     json=body) as response:
                response.raise_for_status()
                complete = False
                async for data in sse_data(response):
                    if data == "[DONE]":
                        complete = True
                        break
                    event = json.loads(data)
                    if "error" in event:
                        raise ProviderError("chat upstream error")
                    for choice in event.get("choices", []):
                        if choice.get("index", 0) != 0:
                            continue
                        content = choice.get("delta", {}).get("content")
                        if isinstance(content, str) and content:
                            yield content
                        if choice.get("finish_reason") is not None:
                            complete = True
                if not complete:
                    raise ProviderError("incomplete chat stream")


def speech_headers(s, service):
    headers = {"X-Api-Resource-Id": getattr(s, f"{service}_resource_id"),
               "X-Api-Request-Id": str(uuid.uuid4())}
    api_key = getattr(s, f"{service}_api_key")
    if api_key:
        headers["X-Api-Key"] = api_key
    else:
        # The vendor uses different legacy APP ID header names for ASR and TTS.
        headers["X-Api-App-Key" if service == "asr" else "X-Api-App-Id"] = getattr(s, f"{service}_app_id")
        headers["X-Api-Access-Key"] = getattr(s, f"{service}_access_token")
    if service == "asr":
        headers["X-Api-Sequence"] = "-1"
        headers["X-Api-Connect-Id"] = str(uuid.uuid4())
    return headers


class VolcTTS:
    def __init__(self, settings, transport=None):
        self.s, self.transport = settings, transport
        self.sample_rate = settings.tts_sample_rate
        if self.sample_rate not in {8000, 16000, 22050, 24000, 32000, 44100, 48000}:
            raise ValueError("Unsupported TTS sample rate")

    async def synthesize(self, text):
        body = {"user": {"uid": "zhijian-demo"}, "req_params": {
            "text": text, "speaker": self.s.tts_speaker,
            "audio_params": {"format": "pcm", "sample_rate": self.sample_rate}}}
        async with httpx.AsyncClient(timeout=self.s.provider_timeout, transport=self.transport) as client:
            async with client.stream("POST", self.s.tts_url, headers=speech_headers(self.s, "tts"), json=body) as response:
                if response.is_error:
                    raise await http_provider_error(response)
                # The configured default is SSE; ordinary HTTP chunked JSON lines also work.
                events = sse_data(response) if self.s.tts_url.rstrip("/").endswith("/sse") else bounded_lines(response)
                complete = False
                tail = b""
                emitted = 0
                async for data in events:
                    if not data.strip():
                        continue
                    event = json.loads(data)
                    if event.get("code") not in (0, 20000000):
                        raise upstream_event_error(event)
                    if event.get("data"):
                        tail += base64.b64decode(event["data"], validate=True)
                        emitted += len(tail)
                        if emitted > self.sample_rate * 2 * 120:
                            raise ProviderError("TTS audio limit")
                        aligned = len(tail) - len(tail) % 2
                        if aligned:
                            yield tail[:aligned]
                        tail = tail[aligned:]
                    if event.get("code") == 20000000:
                        complete = True
                        break
                if not complete or tail or not emitted:
                    raise ProviderError("incomplete TTS stream")


def asr_packet(payload: bytes, *, audio=False, final=False):
    """No-sequence format explicitly supported by V3; bit 1 marks final input."""
    data = gzip.compress(payload)
    header = bytes((0x11, (0x20 if audio else 0x10) | (2 if final else 0), 0x01 if audio else 0x11, 0))
    return header + struct.pack(">I", len(data)) + data


def parse_asr_packet(raw):
    if not isinstance(raw, bytes) or len(raw) < 8 or raw[0] >> 4 != 1:
        raise ProviderError("invalid ASR packet")
    offset = (raw[0] & 15) * 4
    kind, flags = raw[1] >> 4, raw[1] & 15
    if offset < 4 or flags & ~3:
        raise ProviderError("unsupported ASR header")
    if flags & 1:
        offset += 4
    if kind == 15:
        raise ProviderError("ASR upstream error", upstream_code=struct.unpack_from(">I", raw, offset)[0] if len(raw) >= offset + 4 else None)
    if kind != 9 or len(raw) < offset + 4:
        raise ProviderError("invalid ASR response")
    length = struct.unpack_from(">I", raw, offset)[0]
    data = raw[offset + 4:]
    if len(data) != length or length > 2_000_000:
        raise ProviderError("ASR payload size")
    compression = raw[2] & 15
    if compression == 1:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as zipped:
            data = zipped.read(2_000_001)
    elif compression != 0:
        raise ProviderError("ASR compression")
    if len(data) > 2_000_000 or raw[2] >> 4 != 1:
        raise ProviderError("ASR serialization")
    payload = json.loads(data)
    if payload.get("code", 0) not in (0, 1000, 20000000):
        raise ProviderError("ASR response error", upstream_code=payload.get("code"))
    return payload, bool(flags & 2)


class VolcASR:
    def __init__(self, settings, connector=connect):
        self.s, self.connector = settings, connector

    async def transcribe(self, audio):
        config = {"user": {"uid": "zhijian-demo"},
                  "audio": {"format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1},
                  "request": {"model_name": "bigmodel", "enable_itn": True, "enable_punc": True,
                              "show_utterances": True, "result_type": "full"}}
        async with self.connector(self.s.asr_url, additional_headers=speech_headers(self.s, "asr"),
                                  open_timeout=self.s.provider_timeout, close_timeout=2,
                                  max_size=2_000_000, max_queue=8) as socket:
            await socket.send(asr_packet(json.dumps(config).encode()))

            async def send_audio():
                buffer = b""
                async for chunk in audio:
                    buffer += chunk
                    while len(buffer) >= 6400:  # documented recommended 200 ms PCM packet
                        await socket.send(asr_packet(buffer[:6400], audio=True))
                        buffer = buffer[6400:]
                await socket.send(asr_packet(buffer, audio=True, final=True))

            sender = asyncio.create_task(send_audio())
            previous = ""
            try:
                while True:
                    if sender.done():
                        sender.result()
                    raw = await asyncio.wait_for(socket.recv(), timeout=self.s.provider_timeout)
                    payload, final = parse_asr_packet(raw)
                    result = payload.get("result", {})
                    if isinstance(result, list):
                        result = result[0] if result else {}
                    text = result.get("text", "")
                    if not isinstance(text, str):
                        raise ProviderError("invalid ASR text")
                    if final:
                        # A definite utterance is not the end of the entire recording.
                        yield Transcript(text or previous, True)
                        break
                    if text and text != previous:
                        previous = text
                        yield Transcript(text, False)
            finally:
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)
