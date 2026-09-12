"""Exercise real expert routing with controlled providers; no network credentials."""
import asyncio
import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.experts import build_experts
from server.main import create_app
from server.providers import Providers, Transcript
from server.settings import Settings


class Chat:
    def __init__(self):
        self.messages = []

    async def stream(self, messages):
        self.messages.append(messages)
        yield "先看使用效果。"
        yield "再看需要改进的地方。"


class ASR:
    async def transcribe(self, audio):
        async for _ in audio:
            yield Transcript("怎样判断", False)
        yield Transcript("怎样判断工具有没有价值？", True)


class TTS:
    sample_rate = 24000

    def __init__(self):
        self.texts = []

    async def synthesize(self, text):
        self.texts.append(text)
        yield bytes([0, 1] * 120)


def receive_until(ws, kind):
    events = []
    for _ in range(100):
        message = ws.receive()
        event = json.loads(message["text"]) if "text" in message else {"type": "binary"}
        events.append(event)
        if event["type"] == kind:
            return events
    pytest.fail(f"Missing {kind}")


def start(ws, expert, profile=False):
    ws.send_json({"type": "session.start", "use_demo_profile": profile})
    ready = ws.receive_json()
    assert ready["type"] == "session.ready" and ready["expert_id"] == expert
    assert ws.receive_json()["value"] == "idle"


def test_config_is_allowlisted_and_profiles_are_explicit():
    with TestClient(create_app(Settings(allowed_hosts=("testserver",)), Providers())) as c:
        sally = c.get("/api/config").json()
        robin = c.get("/api/config?expert_id=robin-li").json()
        assert sally["expert_id"] == "sally" and sally["default_use_demo_profile"] is True
        assert robin["name"] == "李彦宏" and robin["default_use_demo_profile"] is False
        assert all(q["id"].startswith("robin-") for q in robin["qa"])
        assert robin["qa"] != sally["qa"]
        assert robin["profile"] == sally["profile"]  # One optional student fixture, not expert biography.
        assert robin["capabilities"] == {"llm": False, "asr": False, "tts": False}
        assert "persona" not in robin and "speaker" not in robin
        for unknown in ("unknown", "../content", "", "ROBIN-LI"):
            assert c.get("/api/config", params={"expert_id": unknown}).status_code == 404
            with pytest.raises(WebSocketDisconnect) as rejected:
                with c.websocket_connect("/ws/voice?expert_id=" + unknown):
                    pass
            assert rejected.value.code == 1008


def test_render_variables_override_only_robin(monkeypatch):
    monkeypatch.setenv("VOLC_TTS_SPEAKER", "sally-sentinel")
    monkeypatch.setenv("VOLC_TTS_RESOURCE_ID", "sally-resource")
    monkeypatch.setenv("ROBIN_TTS_SPEAKER", "robin-sentinel")
    monkeypatch.setenv("ROBIN_TTS_RESOURCE_ID", "robin-resource")
    s = Settings.from_env()
    assert (s.tts_speaker, s.tts_resource_id) == ("sally-sentinel", "sally-resource")
    assert (s.robin_tts_speaker, s.robin_tts_resource_id) == ("robin-sentinel", "robin-resource")


def test_each_actual_tts_request_uses_its_own_voice_without_mutating_settings():
    requests = []

    def respond(request):
        requests.append((request.headers["X-Api-Resource-Id"], json.loads(request.content)))
        audio = base64.b64encode(bytes(240)).decode()
        return httpx.Response(200, headers={"content-type": "text/event-stream"},
                              text='data: ' + json.dumps({"code": 0, "data": audio})
                              + '\n\ndata: {"code":20000000}\n\n')

    settings = Settings(tts_api_key="test-only-sentinel", tts_speaker="sally-voice",
                        tts_resource_id="sally-resource")
    experts = build_experts(settings)
    sally, robin = experts["sally"], experts["robin-li"]
    for expert in experts.values():
        expert.providers.tts.transport = httpx.MockTransport(respond)

    async def synthesize(expert):
        return b"".join([chunk async for chunk in expert.providers.tts.synthesize("同一段测试。")])

    async def scenario():
        assert all(await asyncio.gather(synthesize(sally), synthesize(robin), synthesize(sally)))

    asyncio.run(scenario())
    assert [(resource, body["req_params"]["speaker"]) for resource, body in requests] == [
        ("sally-resource", "sally-voice"),
        ("seed-tts-2.0", "zh_male_m191_uranus_bigtts"),
        ("sally-resource", "sally-voice"),
    ]
    assert settings.tts_speaker == "sally-voice"
    assert sally.providers.tts is not robin.providers.tts


def test_two_experts_keep_context_and_history_separate_and_reset_correctly():
    chats = {name: Chat() for name in ("sally", "robin-li")}
    providers = {name: Providers(llm=chat) for name, chat in chats.items()}
    with TestClient(create_app(Settings(allowed_hosts=("testserver",)), providers)) as c:
        with c.websocket_connect("/ws/voice") as sally, c.websocket_connect("/ws/voice?expert_id=robin-li") as robin:
            start(sally, "sally", True)
            start(robin, "robin-li")
            sally.send_json({"type": "input.text", "text": "SALLY-PRIVATE", "speak": False})
            receive_until(sally, "turn.end")
            robin.send_json({"type": "input.text", "text": "ROBIN-PRIVATE", "speak": False})
            receive_until(robin, "turn.end")
            prompt = chats["robin-li"].messages[-1][0]["content"]
            assert "李彦宏 AI 分身" in prompt and "2024 年 7 月" in prompt
            assert "Sally 的角色规则" not in prompt and "清华大学金融硕士生" not in prompt
            assert "尚未提供个人信息" in prompt
            assert "ROBIN-PRIVATE" not in str(chats["sally"].messages)
            assert "SALLY-PRIVATE" not in str(chats["robin-li"].messages)
            robin.send_json({"type": "input.text", "text": "继续", "speak": False})
            receive_until(robin, "turn.end")
            assert chats["robin-li"].messages[-1][-2]["role"] == "assistant"
            robin.send_json({"type": "session.reset"})
            assert receive_until(robin, "session.ready")[-1]["expert_id"] == "robin-li"
            robin.send_json({"type": "input.text", "text": "重置后", "speak": False})
            receive_until(robin, "turn.end")
            assert len(chats["robin-li"].messages[-1]) == 2
            # A socket cannot silently become another person via session.start.
            robin.send_json({"type": "session.start", "expert_id": "sally"})
            assert receive_until(robin, "error")[-1]["code"] == "INVALID_EXPERT"
        with c.websocket_connect("/ws/voice?expert_id=robin-li") as fresh:
            start(fresh, "robin-li")
            fresh.send_json({"type": "input.text", "text": "新连接", "speak": False})
            receive_until(fresh, "turn.end")
            assert len(chats["robin-li"].messages[-1]) == 2


def test_robin_audio_reaches_asr_llm_tts_and_playback_ack_history():
    chat, speech = Chat(), TTS()
    bundles = {"sally": Providers(), "robin-li": Providers(chat, ASR(), speech)}
    with TestClient(create_app(Settings(allowed_hosts=("testserver",)), bundles)) as c:
        with c.websocket_connect("/ws/voice?expert_id=robin-li") as ws:
            start(ws, "robin-li", True)
            ws.send_json({"type": "audio.start", "request_id": "robin-audio"})
            ws.send_bytes(bytes(3200))
            ws.send_json({"type": "audio.end"})
            events = receive_until(ws, "turn.end")
            assert any(e["type"] == "transcript.final" for e in events)
            assert any(e["type"] == "binary" for e in events)
            assert all(e.get("request_id") == "robin-audio" for e in events if e["type"] != "binary")
            assert speech.texts == ["先看使用效果。", "再看需要改进的地方。"]
            profile = json.loads(chat.messages[0][0]["content"].split("\n本次选用的用户资料：")[1])
            assert profile["confirmed"]
            ends = [e for e in events if e["type"] == "audio.end"]
            for event in ends:
                ws.send_json({"type": "playback.ack", "turn_id": event["turn_id"], "segment_id": event["segment_id"]})
            ws.send_json({"type": "input.text", "text": "继续解释", "speak": False})
            receive_until(ws, "turn.end")
            assert chat.messages[-1][-2]["content"] == "先看使用效果。再看需要改进的地方。"


def test_robin_config_does_not_expose_keys_and_does_not_fallback_to_sally_tts():
    settings = Settings(allowed_hosts=("testserver",), llm_api_key="private-llm", llm_model="",
                        tts_api_key="private-tts", robin_tts_speaker="")
    with TestClient(create_app(settings)) as c:
        robin = c.get("/api/config?expert_id=robin-li")
        assert robin.json()["capabilities"] == {"llm": False, "asr": False, "tts": False}
        assert c.get("/api/config").json()["capabilities"]["tts"] is True
        assert "private-" not in robin.text
