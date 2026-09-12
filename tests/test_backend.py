"""Controlled test providers only. Production has no fallback or mock mode."""
import asyncio
import json
import threading

from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect

from server.context import Content
from server.main import create_app
from server.providers import Providers, Transcript
from server.session import VoiceSession
from server.settings import ROOT, Settings


class Chat:
    def __init__(self):
        self.messages = []

    async def stream(self, messages):
        self.messages.append(messages)
        yield "第一句。"
        await asyncio.sleep(0)
        yield "第二句。"


class Speech:
    sample_rate = 24000
    async def synthesize(self, text):
        yield b"\x00\x01" * 4


class Recognition:
    async def transcribe(self, audio):
        async for _ in audio:
            yield Transcript("问题", False)
        yield Transcript("最终问题", True)
        yield Transcript("最终问题", True)


def client(providers=None, **kwargs):
    return TestClient(create_app(Settings(allowed_hosts=("testserver",), **kwargs), providers or Providers()))


def start(ws, profile=False):
    ws.send_json({"type": "session.start", "use_demo_profile": profile})
    assert ws.receive_json()["type"] == "session.ready"
    assert ws.receive_json() == {"type": "state", "value": "idle"}


def until(ws, event_type):
    events = []
    for _ in range(100):
        frame = ws.receive()
        event = json.loads(frame["text"]) if "text" in frame else {"type": "binary", "bytes": frame["bytes"]}
        events.append(event)
        if event["type"] == event_type:
            return events
    pytest.fail("expected event missing")


def test_unconfigured_is_honest_and_never_exposes_credentials():
    app = create_app(Settings(llm_api_key="secret-sentinel", llm_model="", allowed_hosts=("testserver",)))
    with TestClient(app) as c:
        config = c.get("/api/config")
        assert config.status_code == 200
        assert config.json()["capabilities"] == {"llm": False, "asr": False, "tts": False}
        assert "answer" in config.json()["qa"][0]
        assert "secret-sentinel" not in config.text
        assert c.get("/health").json()["status"] == "ok"
        assert c.get("/").status_code == 200
        with c.websocket_connect("/ws/voice") as ws:
            start(ws)
            ws.send_json({"type": "input.text", "text": "你好"})
            assert ws.receive_json()["code"] == "LLM_UNAVAILABLE"
            ws.send_json({"type": "audio.start"})
            assert ws.receive_json()["code"] == "VOICE_UNAVAILABLE"


def test_origin_and_host_rejection():
    with client() as c:
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/ws/voice", headers={"origin": "https://evil.example"}):
                pass
        with c.websocket_connect("/ws/voice", headers={"origin": "http://testserver"}) as ws:
            start(ws)
        assert c.get("/health", headers={"host": "evil.example"}).status_code == 400


def test_text_stream_and_per_connection_isolation():
    llm = Chat()
    with client(Providers(llm=llm)) as c:
        with c.websocket_connect("/ws/voice") as a, c.websocket_connect("/ws/voice") as b:
            start(a, True)
            start(b, False)
            a.send_json({"type": "input.text", "text": "我的唯一问题"})
            events = until(a, "turn.end")
            assert "".join(e["text"] for e in events if e["type"] == "reply.delta") == "第一句。第二句。"
            a.send_json({"type": "input.text", "text": "追问"})
            until(a, "turn.end")
            assert llm.messages[1][-2] == {"role": "assistant", "content": "第一句。第二句。"}
            b.send_json({"type": "input.text", "text": "另一连接"})
            until(b, "turn.end")
            assert len(llm.messages[2]) == 2
            assert "我的唯一问题" not in json.dumps(llm.messages[2], ensure_ascii=False)
            assert "尚未提供个人信息" in llm.messages[2][0]["content"]


def test_playback_ack_after_turn_end_commits_only_played_prefix():
    llm = Chat()
    with client(Providers(llm=llm, tts=Speech())) as c, c.websocket_connect("/ws/voice") as ws:
        start(ws)
        ws.send_json({"type": "input.text", "text": "先回答"})
        events = until(ws, "turn.end")
        tid = events[-1]["turn_id"]
        assert len([e for e in events if e["type"] == "audio.end"]) == 2
        assert len([e for e in events if e["type"] == "binary"]) == 2
        ws.send_json({"type": "playback.ack", "turn_id": tid, "segment_id": 0})
        ws.send_json({"type": "interrupt"})
        until(ws, "interrupted")
        ws.send_json({"type": "input.text", "text": "只依据听到的内容", "speak": False})
        until(ws, "turn.end")
        assert llm.messages[-1][-2] == {"role": "assistant", "content": "第一句。"}
        assert "第二句。" not in str(llm.messages[-1][1:])


def test_unplayed_speech_never_enters_history_and_stale_ack_is_ignored():
    llm = Chat()
    with client(Providers(llm=llm, tts=Speech())) as c, c.websocket_connect("/ws/voice") as ws:
        start(ws)
        ws.send_json({"type": "input.text", "text": "问题一"})
        tid = until(ws, "turn.end")[-1]["turn_id"]
        ws.send_json({"type": "input.text", "text": "问题二", "speak": False})
        until(ws, "turn.end")
        ws.send_json({"type": "playback.ack", "turn_id": tid, "segment_id": 1})
        assert all(m["role"] != "assistant" for m in llm.messages[-1][1:])


def test_asr_final_and_audio_end_duplicates_trigger_once():
    llm = Chat()
    with client(Providers(llm=llm, asr=Recognition())) as c, c.websocket_connect("/ws/voice") as ws:
        start(ws)
        ws.send_json({"type": "audio.start"})
        assert ws.receive_json()["value"] == "listening"
        ws.send_bytes(b"\x00\x01" * 100)
        ws.send_json({"type": "audio.end"})
        ws.send_json({"type": "audio.end"})
        events = until(ws, "turn.end")
        assert len([e for e in events if e["type"] == "transcript.final"]) == 1
        assert len(llm.messages) == 1
        assert llm.messages[0][-1]["content"] == "最终问题"


def test_reset_clears_history_preserves_profile():
    llm = Chat()
    with client(Providers(llm=llm)) as c, c.websocket_connect("/ws/voice") as ws:
        start(ws, True)
        ws.send_json({"type": "input.text", "text": "之前的问题"})
        until(ws, "turn.end")
        ws.send_json({"type": "session.reset"})
        until(ws, "session.ready")
        ws.send_json({"type": "input.text", "text": "重置之后"})
        until(ws, "turn.end")
        assert len(llm.messages[-1]) == 2
        assert llm.messages[-1][0] == llm.messages[0][0]


def test_demo_memory_reaches_text_and_asr_requests_and_retains_user_correction():
    llm = Chat()
    expected = Content(ROOT / "content").profile
    with client(Providers(llm=llm, asr=Recognition())) as c, c.websocket_connect("/ws/voice") as ws:
        start(ws, True)
        ws.send_json({"type": "input.text", "text": "纠正一下，我做过战略研究，没有投研实习。", "speak": False})
        until(ws, "turn.end")
        ws.send_json({"type": "audio.start"})
        ws.send_bytes(b"\x00\x01" * 100)
        ws.send_json({"type": "audio.end"})
        until(ws, "turn.end")
        assert len(llm.messages) == 2
        for messages in llm.messages:
            supplied = json.loads(messages[0]["content"].split("\n本次选用的用户资料：", 1)[1])
            assert supplied == expected
        assert llm.messages[-1][1]["content"] == "纠正一下，我做过战略研究，没有投研实习。"
        assert llm.messages[-1][-1]["content"] == "最终问题"
        # Switching the same socket to blank mode must clear both profile and history.
        ws.send_json({"type": "session.start", "use_demo_profile": False})
        until(ws, "session.ready")
        ws.send_json({"type": "input.text", "text": "全新的咨询者", "speak": False})
        until(ws, "turn.end")
        supplied = json.loads(llm.messages[-1][0]["content"].split("\n本次选用的用户资料：", 1)[1])
        assert supplied["confirmed"] == {}
        assert len(llm.messages[-1]) == 2


def test_malformed_and_limits_remain_usable():
    with client(Providers(llm=Chat(), asr=Recognition()), max_text_chars=5, max_audio_frame_bytes=20) as c:
        with c.websocket_connect("/ws/voice") as ws:
            start(ws)
            ws.send_text("bad-json")
            assert ws.receive_json()["code"] == "INVALID_MESSAGE"
            ws.send_json({"type": "input.text", "text": "x" * 6})
            assert ws.receive_json()["code"] == "TEXT_LIMIT"
            ws.send_json({"type": "audio.start"})
            ws.receive_json()
            ws.send_bytes(b"x" * 22)
            assert until(ws, "error")[-1]["code"] == "AUDIO_LIMIT"
            ws.send_json({"type": "input.text", "text": "有效"})
            assert until(ws, "turn.end")[-1]["turn_id"]


class Socket:
    def __init__(self):
        self.sent = []
    async def send_json(self, obj):
        self.sent.append(obj)
    async def send_bytes(self, obj):
        self.sent.append(obj)


def test_interrupt_cancels_llm_and_prevents_stale_frames():
    async def scenario():
        closed = asyncio.Event()
        class SlowChat:
            async def stream(self, messages):
                try:
                    yield "开始"
                    await asyncio.Event().wait()
                    yield "不应发送"
                finally:
                    closed.set()
        sock = Socket()
        session = VoiceSession(sock, Providers(llm=SlowChat()), Settings(), Content(ROOT / "content"))
        await session.handle({"type": "session.start"})
        await session.handle({"type": "input.text", "text": "测试"})
        while not any(isinstance(e, dict) and e["type"] == "reply.delta" for e in sock.sent):
            await asyncio.sleep(0)
        old = session.turn
        await session.handle({"type": "interrupt"})
        assert closed.is_set()
        length = len(sock.sent)
        await session.event(old, "reply.delta", text="stale")
        await session.binary(old, b"\x00\x00")
        assert len(sock.sent) == length
        assert all(m["role"] != "assistant" for m in session.history)
    asyncio.run(scenario())


def test_audio_queue_overflow_cancels_asr():
    async def scenario():
        closed = asyncio.Event()
        entered = asyncio.Event()
        class SlowRecognition:
            async def transcribe(self, audio):
                try:
                    entered.set()
                    await asyncio.Event().wait()
                    yield Transcript("never", True)
                finally:
                    closed.set()
        sock = Socket()
        session = VoiceSession(sock, Providers(llm=Chat(), asr=SlowRecognition()),
                               Settings(max_audio_queue=1), Content(ROOT / "content"))
        await session.handle({"type": "session.start"})
        await session.handle({"type": "audio.start"})
        await entered.wait()
        await session.receive_audio(b"\x00\x00")
        await session.receive_audio(b"\x00\x00")
        assert closed.is_set()
        assert session.audio_queue is None
        assert sock.sent[-1]["code"] == "AUDIO_LIMIT"
    asyncio.run(scenario())


def test_upstream_exception_is_sanitized():
    class BrokenChat:
        async def stream(self, messages):
            raise RuntimeError("secret-api-key-in-upstream-url")
            yield "unused"
    with client(Providers(llm=BrokenChat())) as c, c.websocket_connect("/ws/voice") as ws:
        start(ws)
        ws.send_json({"type": "input.text", "text": "问题"})
        events = until(ws, "turn.end")
        assert any(e.get("code") == "GENERATION_FAILED" for e in events)
        assert "secret-api-key" not in json.dumps(events)


def test_socket_disconnect_cancels_provider():
    entered, ended = threading.Event(), threading.Event()
    class SlowChat:
        async def stream(self, messages):
            entered.set()
            try:
                yield "开始"
                await asyncio.Event().wait()
            finally:
                ended.set()
    with client(Providers(llm=SlowChat())) as c:
        with c.websocket_connect("/ws/voice") as ws:
            start(ws)
            ws.send_json({"type": "input.text", "text": "测试"})
            until(ws, "reply.delta")
        assert entered.is_set()
        assert ended.wait(2)


def test_provider_timeout_returns_clean_error():
    class StalledChat:
        async def stream(self, messages):
            await asyncio.Event().wait()
            yield "never"
    with client(Providers(llm=StalledChat()), provider_timeout=0.02) as c, c.websocket_connect("/ws/voice") as ws:
        start(ws)
        ws.send_json({"type": "input.text", "text": "测试超时"})
        assert any(e.get("code") == "GENERATION_FAILED" for e in until(ws, "turn.end"))


def test_failed_tts_cancels_generation_and_does_not_commit_tail():
    class LongChat(Chat):
        async def stream(self, messages):
            self.messages.append(messages)
            for _ in range(30):
                yield "句子。"
    class BrokenSpeech:
        sample_rate = 24000
        async def synthesize(self, text):
            await asyncio.sleep(0)
            raise ValueError("private upstream error")
            yield b""
    async def scenario():
        llm = LongChat()
        sock = Socket()
        session = VoiceSession(sock, Providers(llm=llm, tts=BrokenSpeech()), Settings(), Content(ROOT / "content"))
        await session.handle({"type": "session.start"})
        await session.handle({"type": "input.text", "text": "测试"})
        await asyncio.wait_for(session.task, 1)
        assert any(isinstance(e, dict) and e.get("code") == "GENERATION_FAILED" for e in sock.sent)
        assert not any(m["role"] == "assistant" for m in session.history)
        assert "private upstream error" not in str(sock.sent)
        assert next(e for e in sock.sent if isinstance(e, dict) and e.get("code") == "GENERATION_FAILED")["diagnostic"] == "TTS"
    asyncio.run(scenario())


def test_audio_duration_limit_and_reset_during_generation():
    async def scenario():
        closed = asyncio.Event()
        class SlowChat:
            async def stream(self, messages):
                try:
                    yield "测试"
                    await asyncio.Event().wait()
                finally:
                    closed.set()
        sock = Socket()
        session = VoiceSession(sock, Providers(llm=SlowChat(), asr=Recognition()),
                               Settings(max_audio_seconds=0.001), Content(ROOT / "content"))
        await session.handle({"type": "session.start", "use_demo_profile": True})
        await session.handle({"type": "audio.start"})
        await session.receive_audio(b"\x00\x00" * 30)
        assert sock.sent[-1]["code"] == "AUDIO_LIMIT"
        await session.handle({"type": "input.text", "text": "会被重置"})
        while not any(isinstance(e, dict) and e["type"] == "reply.delta" for e in sock.sent):
            await asyncio.sleep(0)
        await session.handle({"type": "session.reset"})
        assert closed.is_set()
        assert session.history == [] and session.use_demo_profile
    asyncio.run(scenario())


def test_out_of_order_and_duplicate_ack_commit_contiguous_prefix_once():
    async def scenario():
        sock = Socket()
        session = VoiceSession(sock, Providers(llm=Chat(), tts=Speech()), Settings(), Content(ROOT / "content"))
        await session.handle({"type": "session.start"})
        await session.handle({"type": "input.text", "text": "测试"})
        await session.task
        tid = session.turn.id
        await session.handle({"type": "playback.ack", "turn_id": tid, "segment_id": 1})
        assert len(session.history) == 1
        await session.handle({"type": "playback.ack", "turn_id": tid, "segment_id": 0})
        await session.handle({"type": "playback.ack", "turn_id": tid, "segment_id": 0})
        assert session.history[-1] == {"role": "assistant", "content": "第一句。第二句。"}
        assert len(session.history) == 2
    asyncio.run(scenario())


def test_llm_failure_closes_concurrent_tts_before_turn_end():
    async def scenario():
        entered = asyncio.Event()
        stopped = asyncio.Event()
        class BrokenChat:
            async def stream(self, messages):
                yield "第一句。"
                await entered.wait()
                raise RuntimeError("private")
        class SlowSpeech:
            sample_rate = 24000
            async def synthesize(self, text):
                entered.set()
                try:
                    yield b"\x00\x00"
                    await asyncio.Event().wait()
                finally:
                    stopped.set()
        sock = Socket()
        session = VoiceSession(sock, Providers(llm=BrokenChat(), tts=SlowSpeech()), Settings(), Content(ROOT / "content"))
        await session.handle({"type": "session.start"})
        await session.handle({"type": "input.text", "text": "测试"})
        await asyncio.wait_for(session.task, 1)
        assert stopped.is_set()
        assert sock.sent[-2]["type"] == "turn.end"
        assert sock.sent[-1]["value"] == "idle"
    asyncio.run(scenario())


def test_request_id_echoes_all_text_turn_events_and_interrupt():
    with client(Providers(llm=Chat(), tts=Speech())) as c, c.websocket_connect("/ws/voice") as ws:
        start(ws)
        ws.send_json({"type": "input.text", "request_id": "text-request-1", "text": "测试"})
        events = until(ws, "turn.end")
        events.append(ws.receive_json())
        for event in events:
            if event["type"] != "binary":
                assert event["request_id"] == "text-request-1"
                assert event["turn_id"] == events[-2]["turn_id"]
        ws.send_json({"type": "interrupt"})
        assert ws.receive_json()["request_id"] == "text-request-1"
        assert ws.receive_json()["request_id"] == "text-request-1"


def test_request_id_echoes_asr_transcripts_and_audio_states():
    with client(Providers(llm=Chat(), asr=Recognition())) as c, c.websocket_connect("/ws/voice") as ws:
        start(ws)
        ws.send_json({"type": "audio.start", "request_id": "audio-request-2"})
        assert ws.receive_json()["request_id"] == "audio-request-2"
        ws.send_bytes(b"\x00\x00" * 40)
        ws.send_json({"type": "audio.end"})
        events = until(ws, "turn.end")
        assert any(e["type"] == "transcript.partial" for e in events)
        assert any(e["type"] == "transcript.final" for e in events)
        assert all(e["request_id"] == "audio-request-2" for e in events)


@pytest.mark.parametrize("message, code", [
    ({"type": "input.text", "text": ""}, "TEXT_LIMIT"),
    ({"type": "input.text", "text": "测试"}, "LLM_UNAVAILABLE"),
    ({"type": "audio.start"}, "VOICE_UNAVAILABLE"),
])
def test_preturn_validation_echoes_valid_request_id(message, code):
    with client() as c, c.websocket_connect("/ws/voice") as ws:
        start(ws)
        ws.send_json({**message, "request_id": "validation-3"})
        error = ws.receive_json()
        assert error["code"] == code
        assert error["request_id"] == "validation-3"


@pytest.mark.parametrize("request_id", [42, [], "x" * 101])
def test_invalid_request_id_is_bounded(request_id):
    with client() as c, c.websocket_connect("/ws/voice") as ws:
        start(ws)
        ws.send_json({"type": "input.text", "text": "测试", "request_id": request_id})
        error = ws.receive_json()
        assert error["code"] == "INVALID_MESSAGE"
        assert "request_id" not in error


def test_request_id_echoes_generation_and_asr_errors():
    class BrokenChat:
        async def stream(self, messages):
            raise RuntimeError("private")
            yield "never"
    class BrokenASR:
        async def transcribe(self, audio):
            raise RuntimeError("private")
            yield Transcript("never")
    with client(Providers(llm=BrokenChat(), asr=BrokenASR())) as c, c.websocket_connect("/ws/voice") as ws:
        start(ws)
        ws.send_json({"type": "input.text", "text": "测试", "request_id": "chat-failure"})
        events = until(ws, "turn.end")
        assert next(e for e in events if e["type"] == "error")["request_id"] == "chat-failure"
        ws.send_json({"type": "audio.start", "request_id": "asr-failure"})
        events = until(ws, "error")
        assert events[-1]["code"] == "ASR_FAILED"
        assert events[-1]["request_id"] == "asr-failure"


def test_request_id_survives_audio_limit_cancellation():
    with client(Providers(llm=Chat(), asr=Recognition()), max_audio_frame_bytes=10) as c:
        with c.websocket_connect("/ws/voice") as ws:
            start(ws)
            ws.send_json({"type": "audio.start", "request_id": "oversized-audio"})
            ws.receive_json()
            ws.send_bytes(b"\x00\x00" * 10)
            events = until(ws, "error")
            assert events[-1]["code"] == "AUDIO_LIMIT"
            assert all(e["request_id"] == "oversized-audio" for e in events)


def test_asr_failure_is_not_overwritten_by_late_microphone_packets():
    class BrokenASR:
        async def transcribe(self, audio):
            raise RuntimeError("private upstream secret")
            yield Transcript("never")
    async def scenario():
        sock = Socket()
        session = VoiceSession(sock, Providers(llm=Chat(), asr=BrokenASR()), Settings(), Content(ROOT / "content"))
        await session.handle({"type": "session.start"})
        await session.handle({"type": "audio.start", "request_id": "failed-recording"})
        await session.task
        for _ in range(12):
            await session.receive_audio(bytes(3200))
        errors = [e for e in sock.sent if e.get("type") == "error"]
        assert len(errors) == 1
        assert errors[0]["code"] == "ASR_FAILED"
        assert "private upstream secret" not in str(sock.sent)
        # A later recording must still accept audio.
        session.p.asr = Recognition()
        await session.handle({"type": "audio.start", "request_id": "retry-recording"})
        await session.receive_audio(bytes(3200))
        await session.handle({"type": "audio.end"})
        await session.task
        assert any(e.get("type") == "transcript.final" and e.get("request_id") == "retry-recording" for e in sock.sent)
    asyncio.run(scenario())
