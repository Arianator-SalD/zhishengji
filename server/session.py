import asyncio
from contextlib import suppress
from dataclasses import dataclass, field
import json
import re
import uuid

from fastapi import WebSocketDisconnect

from .providers import asr_failure_details, generation_failure_details


@dataclass
class Segment:
    text: str
    complete: bool = False
    acknowledged: bool = False


@dataclass
class Turn:
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    request_id: str | None = None
    segments: list[Segment] = field(default_factory=list)
    assistant: dict | None = None
    active: bool = True


class VoiceSession:
    """Single receiver orders ACKs before the next question's history snapshot.

    No disk storage, global session registry, or shared conversation messages.
    The client must send known playback ACKs before interrupt/new input.
    """
    def __init__(self, socket, providers, settings, content, *, expert_id="sally"):
        self.ws, self.p, self.s, self.content = socket, providers, settings, content
        self.expert_id = expert_id
        self.history = []
        self.use_demo_profile = False
        self.started = False
        self.turn = None
        self.task = None
        self.audio_queue = None
        self.audio_bytes = 0
        self.audio_ending = False
        self.audio_closed = False
        self.closed = False
        self.send_lock = asyncio.Lock()

    async def send(self, type, **payload):
        async with self.send_lock:
            if not self.closed:
                await self.ws.send_json({"type": type, **payload})

    async def event(self, turn, type, **payload):
        async with self.send_lock:
            if not self.closed and turn is self.turn and turn.active:
                await self.ws.send_json({"type": type, **self.turn_tags(turn), **payload})

    @staticmethod
    def turn_tags(turn):
        if turn is None:
            return {}
        tags = {"turn_id": turn.id}
        if turn.request_id is not None:
            tags["request_id"] = turn.request_id
        return tags

    async def binary(self, turn, chunk):
        async with self.send_lock:
            if not self.closed and turn is self.turn and turn.active:
                await self.ws.send_bytes(chunk)

    async def error(self, code, message, **tags):
        await self.send("error", code=code, message=message, **tags)

    async def stop(self, notify=False):
        old = self.turn
        if old:
            old.active = False
        task, self.task = self.task, None
        self.audio_queue = None
        self.audio_ending = False
        self.audio_closed = True
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.turn = None
        if notify:
            tags = self.turn_tags(old)
            await self.send("interrupted", **({"turn_id": None} | tags))
            await self.send("state", value="idle", **tags)

    async def ready(self):
        await self.send("session.ready", expert_id=self.expert_id, capabilities=self.p.capabilities,
                        qa=self.content.questions, profile=self.content.profile)
        await self.send("state", value="idle")

    def acknowledge(self, message):
        turn = self.turn
        segment_id = message.get("segment_id")
        if not turn or message.get("turn_id") != turn.id or type(segment_id) is not int:
            return
        if not 0 <= segment_id < len(turn.segments):
            return
        segment = turn.segments[segment_id]
        if not segment.complete:
            return
        segment.acknowledged = True
        text = ""
        for piece in turn.segments:
            if not piece.acknowledged:
                break
            text += piece.text
        if text:
            if turn.assistant is None:
                turn.assistant = {"role": "assistant", "content": text}
                self.history.append(turn.assistant)
            else:
                turn.assistant["content"] = text

    def new_turn(self, request_id=None):
        self.turn = Turn(request_id=request_id)
        return self.turn

    async def generate(self, turn, text, speak=True):
        self.history.append({"role": "user", "content": text})
        self.history = self.history[-self.s.max_history_messages:]
        while self.history and self.history[0]["role"] == "assistant":
            self.history.pop(0)
        messages = self.content.messages(self.history, self.use_demo_profile)
        speech = bool(speak and self.p.tts)
        queue = asyncio.Queue(maxsize=8)
        speaker_task = None

        async def speak_sentences():
            total_audio = 0
            while True:
                sentence = await queue.get()
                if sentence is None:
                    return
                segment_id = len(turn.segments)
                segment = Segment(sentence)
                turn.segments.append(segment)
                await self.event(turn, "state", value="speaking")
                await self.event(turn, "audio.start", turn_id=turn.id, segment_id=segment_id,
                                 text=sentence, sample_rate=self.p.tts.sample_rate, format="pcm_s16le")
                received = False
                async with asyncio.timeout(self.s.provider_timeout):
                    async for chunk in self.p.tts.synthesize(sentence):
                        if not isinstance(chunk, bytes) or len(chunk) % 2:
                            raise ValueError("invalid provider audio")
                        total_audio += len(chunk)
                        if total_audio > self.p.tts.sample_rate * 2 * 180:
                            raise ValueError("audio output limit")
                        for start in range(0, len(chunk), 32768):
                            received = True
                            await self.binary(turn, chunk[start:start + 32768])
                if not received:
                    raise ValueError("empty provider audio")
                segment.complete = True
                await self.event(turn, "audio.end", turn_id=turn.id, segment_id=segment_id)

        async def enqueue(sentence):
            if speaker_task and speaker_task.done():
                speaker_task.result()
            put = asyncio.create_task(queue.put(sentence))
            try:
                done, _ = await asyncio.wait({put, speaker_task}, return_when=asyncio.FIRST_COMPLETED)
                if speaker_task in done:
                    speaker_task.result()
                await put
            finally:
                put.cancel()
                await asyncio.gather(put, return_exceptions=True)

        try:
            await self.event(turn, "state", value="thinking")
            if speech:
                speaker_task = asyncio.create_task(speak_sentences())
            full, buffer = "", ""
            async with asyncio.timeout(self.s.provider_timeout * 3):
                iterator = self.p.llm.stream(messages).__aiter__()
                while True:
                    try:
                        delta = await asyncio.wait_for(anext(iterator), self.s.provider_timeout)
                    except StopAsyncIteration:
                        break
                    if not isinstance(delta, str):
                        raise ValueError("invalid chat delta")
                    if len(full) + len(delta) > self.s.max_reply_chars:
                        raise ValueError("reply limit")
                    full += delta
                    await self.event(turn, "reply.delta", turn_id=turn.id, text=delta)
                    if speech:
                        buffer += delta
                        while buffer:
                            match = re.search(r"[。！？!?；;\n]", buffer)
                            end = match.end() if match else (120 if len(buffer) >= 120 else 0)
                            if not end:
                                break
                            sentence, buffer = buffer[:end], buffer[end:]
                            if sentence.strip():
                                await enqueue(sentence)
                if not full.strip():
                    raise ValueError("empty reply")
                if speech:
                    if buffer.strip():
                        await enqueue(buffer)
                    await enqueue(None)
                    await speaker_task
                else:
                    turn.assistant = {"role": "assistant", "content": full}
                    self.history.append(turn.assistant)
            await self.event(turn, "turn.end", turn_id=turn.id)
            await self.event(turn, "state", value="idle")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            stage = "TTS" if (speaker_task and speaker_task.done() and not speaker_task.cancelled()
                              and speaker_task.exception() is exc) else "LLM"
            # Stop output before declaring a failed turn finished. Previously queued
            # complete segments remain ACK-able, but no new audio may follow turn.end.
            if speaker_task:
                speaker_task.cancel()
                await asyncio.gather(speaker_task, return_exceptions=True)
            await self.event(turn, "error", code="GENERATION_FAILED",
                             **generation_failure_details(exc, stage))
            await self.event(turn, "turn.end", turn_id=turn.id)
            await self.event(turn, "state", value="idle")
        finally:
            if speaker_task:
                speaker_task.cancel()
                await asyncio.gather(speaker_task, return_exceptions=True)
            if "iterator" in locals() and hasattr(iterator, "aclose"):
                with suppress(Exception):
                    await iterator.aclose()

    async def recognize(self, turn, queue):
        async def audio():
            while True:
                chunk = await queue.get()
                if chunk is None:
                    return
                yield chunk
        try:
            async with asyncio.timeout(self.s.max_audio_seconds + self.s.provider_timeout):
                iterator = self.p.asr.transcribe(audio()).__aiter__()
                async for item in iterator:
                    if len(item.text) > self.s.max_text_chars:
                        raise ValueError("transcript limit")
                    if item.final:
                        self.audio_queue = None
                        self.audio_ending = False
                        self.audio_closed = True
                        text = item.text.strip()
                        await self.event(turn, "transcript.final", text=text)
                        break
                    await self.event(turn, "transcript.partial", text=item.text)
                else:
                    raise ValueError("missing final transcript")
            if hasattr(iterator, "aclose"):
                await iterator.aclose()
            if text:
                await self.generate(turn, text)
            else:
                await self.event(turn, "error", code="NO_SPEECH", message="没有识别到清晰语音，请重试。")
                await self.event(turn, "state", value="idle")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.audio_queue = None
            self.audio_ending = False
            self.audio_closed = True
            await self.event(turn, "error", code="ASR_FAILED", **asr_failure_details(exc))
            await self.event(turn, "state", value="idle")
        finally:
            if "iterator" in locals() and hasattr(iterator, "aclose"):
                with suppress(Exception):
                    await iterator.aclose()

    async def handle(self, message):
        kind = message.get("type")
        request_id = None
        request_tags = {}
        if kind in ("input.text", "audio.start"):
            request_id = message.get("request_id")
            if request_id is not None and (not isinstance(request_id, str) or len(request_id) > 100):
                return await self.error("INVALID_MESSAGE", "请求标识格式无效。")
            if request_id is not None:
                request_tags["request_id"] = request_id
        if kind == "session.start":
            if message.get("expert_id", self.expert_id) != self.expert_id:
                return await self.error("INVALID_EXPERT", "切换专家需要重新连接。")
            if type(message.get("use_demo_profile", False)) is not bool:
                return await self.error("INVALID_MESSAGE", "档案选择格式无效。")
            await self.stop()
            self.history.clear()
            self.use_demo_profile = message.get("use_demo_profile", False)
            self.started = True
            return await self.ready()
        if not self.started:
            return await self.error("SESSION_REQUIRED", "请先初始化会话。", **request_tags)
        if kind == "playback.ack":
            return self.acknowledge(message)
        if kind == "interrupt":
            return await self.stop(notify=True)
        if kind == "session.reset":
            await self.stop(notify=True)
            self.history.clear()
            return await self.ready()
        if kind == "input.text":
            text = message.get("text")
            if not isinstance(text, str) or not text.strip() or len(text) > self.s.max_text_chars:
                return await self.error("TEXT_LIMIT", f"请输入 1–{self.s.max_text_chars} 字的问题。", **request_tags)
            if type(message.get("speak", True)) is not bool:
                return await self.error("INVALID_MESSAGE", "播报设置格式无效。", **request_tags)
            if not self.p.llm:
                return await self.error("LLM_UNAVAILABLE", "尚未配置对话模型，当前不能生成回答。", **request_tags)
            await self.stop(notify=self.turn is not None)
            turn = self.new_turn(request_id)
            self.task = asyncio.create_task(self.generate(turn, text.strip(), message.get("speak", True)))
            return
        if kind == "audio.start":
            if not self.p.asr or not self.p.llm:
                return await self.error("VOICE_UNAVAILABLE", "请先配置语音识别和对话模型。", **request_tags)
            await self.stop(notify=self.turn is not None)
            turn = self.new_turn(request_id)
            self.audio_queue = asyncio.Queue(maxsize=self.s.max_audio_queue)
            self.audio_bytes = 0
            self.audio_ending = False
            self.audio_closed = False
            self.task = asyncio.create_task(self.recognize(turn, self.audio_queue))
            return await self.event(turn, "state", value="listening")
        if kind == "audio.end":
            if self.audio_queue is None or self.audio_ending:
                return
            self.audio_ending = True
            try:
                self.audio_queue.put_nowait(None)
            except asyncio.QueueFull:
                tags = self.turn_tags(self.turn)
                await self.stop(notify=True)
                return await self.error("AUDIO_LIMIT", "音频缓冲已满，请缩短录音后重试。", **tags)
            return await self.event(self.turn, "state", value="thinking")
        await self.error("INVALID_MESSAGE", "不支持的消息类型。")

    async def receive_audio(self, chunk):
        tags = self.turn_tags(self.turn)
        if self.audio_closed or self.audio_ending:
            return
        if self.audio_queue is None:
            self.audio_closed = True
            return await self.error("AUDIO_NOT_STARTED", "请先开始语音输入。", **tags)
        self.audio_bytes += len(chunk)
        if (not chunk or len(chunk) % 2 or len(chunk) > self.s.max_audio_frame_bytes
                or self.audio_bytes > 32000 * self.s.max_audio_seconds):
            await self.stop(notify=True)
            return await self.error("AUDIO_LIMIT", "音频格式或长度超出限制，请重新录音。", **tags)
        try:
            self.audio_queue.put_nowait(chunk)
        except asyncio.QueueFull:
            await self.stop(notify=True)
            await self.error("AUDIO_LIMIT", "音频缓冲已满，请缩短录音后重试。", **tags)

    async def run(self):
        try:
            while True:
                message = await self.ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    await self.receive_audio(message["bytes"])
                    continue
                raw = message.get("text", "")
                if len(raw) > 16000:
                    await self.error("MESSAGE_LIMIT", "消息过长。")
                    continue
                try:
                    parsed = json.loads(raw)
                    if not isinstance(parsed, dict):
                        raise ValueError()
                except (ValueError, TypeError):
                    await self.error("INVALID_MESSAGE", "消息格式无效。")
                    continue
                await self.handle(parsed)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            self.closed = True
            await self.stop()
            self.history.clear()
