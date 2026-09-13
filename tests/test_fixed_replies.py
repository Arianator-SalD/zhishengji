import asyncio
import json
import shutil
from unittest.mock import AsyncMock

import pytest

from server.context import Content
from server.fixed_replies import FixedReply
from server.providers import Providers, Transcript
from server.session import VoiceSession
from server.settings import ROOT, Settings


@pytest.fixture(autouse=True)
def skip_display_delays(monkeypatch):
    # Keep transport tests fast without changing classifier timeouts or turn
    # cancellation. Production uses real pauses; assert their totals below.
    now = [0.0]
    def advance(delay):
        now[0] += delay
    pause = AsyncMock(side_effect=advance)
    monkeypatch.setattr("server.session.pause_fixed_stream", pause)
    monkeypatch.setattr("server.session.fixed_stream_clock", lambda: now[0])
    return pause


class Chat:
    def __init__(self, decision=None):
        self.decision = decision or {"id": "none"}
        self.classifications = []
        self.generated = []

    async def classify_reply(self, messages):
        self.classifications.append(messages)
        return self.decision

    async def stream(self, messages, **kwargs):
        self.generated.append(messages)
        yield "具体追问的正常回复。"


class Socket:
    def __init__(self):
        self.events = []

    async def send_json(self, event):
        self.events.append(event)

    async def send_bytes(self, data):
        raise AssertionError("Fixed audio must not use streaming PCM")


class ForbiddenTTS:
    sample_rate = 24000

    async def synthesize(self, text):
        raise AssertionError("Fixed audio must not synthesize at runtime")
        yield b""


def content(expert):
    return Content(ROOT / "content" / ("robin-li" if expert == "robin-li" else ""))


def session(expert, chat, tts=None, asr=None):
    return VoiceSession(Socket(), Providers(llm=chat, tts=tts, asr=asr), Settings(),
                        content(expert), expert_id=expert)


def reply(s):
    return "".join(e["text"] for e in s.ws.events if e["type"] == "reply.delta")


@pytest.mark.parametrize("expert", ["sally", "robin-li"])
@pytest.mark.parametrize("speak", [False, True])
def test_exact_fixed_copy_bypasses_generation_and_tts(expert, speak):
    async def run():
        chat = Chat()
        s = session(expert, chat, ForbiddenTTS())
        fixed = s.content.fixed_reply
        turn = s.new_turn("fixed-request")
        await s.generate(turn, fixed.question, speak=speak)
        assert reply(s) == fixed.answer
        assert not chat.generated and not chat.classifications
        assert not any(e["type"] == "error" for e in s.ws.events)
        assets = [e for e in s.ws.events if e["type"] == "audio.file"]
        if speak:
            assert len(assets) == 1
            assert assets[0]["url"] == fixed.audio_url
            assert assets[0]["request_id"] == "fixed-request"
            assert assets[0]["turn_id"] == turn.id
            assert not any(m["role"] == "assistant" for m in s.history)
            s.acknowledge({"turn_id": "stale", "segment_id": 0})
            assert len(s.history) == 1
            s.acknowledge({"turn_id": turn.id, "segment_id": 0})
            s.acknowledge({"turn_id": turn.id, "segment_id": 0})
        else:
            assert not assets
        assert s.history[-1] == {"role": "assistant", "content": fixed.answer}
        assert len(s.history) == 2
    asyncio.run(run())


@pytest.mark.parametrize("expert", ["sally", "robin-li"])
def test_voice_input_and_fixed_audio_work_without_live_tts(expert):
    async def run():
        fixed = content(expert).fixed_reply
        class ASR:
            async def transcribe(self, chunks):
                async for _ in chunks:
                    pass
                yield Transcript(fixed.question, True)
        s = session(expert, Chat(), asr=ASR())
        q = asyncio.Queue()
        await q.put(None)
        await s.recognize(s.new_turn("asr-request"), q)
        assert reply(s) == fixed.answer
        assert any(e["type"] == "audio.file" for e in s.ws.events)
        assert not any(e["type"] == "error" for e in s.ws.events)
    asyncio.run(run())


@pytest.mark.parametrize("expert", ["sally", "robin-li"])
def test_equivalent_full_question_uses_allowlisted_decision(expert):
    fixed = content(expert).fixed_reply
    chat = Chat({"id": fixed.id})
    history = [{"role": "assistant", "content": "上下文" * 1000}] * 6
    assert asyncio.run(fixed.select("换一种问法的初步概述问题", chat, history=history)) is fixed
    payload = json.loads(chat.classifications[0][-1]["content"])
    assert len(payload["recent_history"]) == 4
    assert all(len(m["content"]) <= 1500 for m in payload["recent_history"])
    assert fixed.answer in chat.classifications[0][0]["content"]


@pytest.mark.parametrize("decision", [{"id": "none"}, {"id": "foreign"}, {"id": []},
                                      {"id": "fixed-finance-to-product", "extra": True}, {}, []])
def test_unknown_or_invalid_decision_does_not_freeze(decision):
    fixed = content("sally").fixed_reply
    chat = Chat()
    chat.decision = decision
    assert asyncio.run(fixed.select("具体的新追问", chat)) is None


def test_followup_falls_back_and_keeps_fixed_answer_history():
    async def run():
        chat = Chat()
        s = session("sally", chat)
        await s.generate(s.new_turn(), s.content.fixed_reply.question, speak=False)
        followup = "我已经选了财报分析场景，每周只有两小时，该怎么验证？"
        await s.generate(s.new_turn(), followup, speak=False)
        assert reply(s).endswith("具体追问的正常回复。")
        assert chat.generated[-1][-2]["content"] == s.content.fixed_reply.answer
        assert chat.generated[-1][-1]["content"] == followup
    asyncio.run(run())


def test_no_cross_expert_fixed_match():
    robin = content("robin-li").fixed_reply
    sally = content("sally").fixed_reply
    assert asyncio.run(sally.select(robin.question, Chat({"id": robin.id}))) is None
    assert asyncio.run(robin.select(sally.question, Chat({"id": sally.id}))) is None


def test_cancelled_classifier_cannot_emit_late_answer():
    async def run():
        entered = asyncio.Event()
        class Slow(Chat):
            async def classify_reply(self, messages):
                entered.set()
                await asyncio.sleep(60)
        s = session("sally", Slow())
        s.started = True
        await s.handle({"type": "input.text", "text": "不在别名中的问题", "speak": True})
        task = s.task
        await entered.wait()
        await s.stop()
        assert task.cancelled() and not reply(s)
        assert not any(e["type"] == "audio.file" for e in s.ws.events)
    asyncio.run(run())


def test_changed_copy_or_audio_cannot_silently_use_old_recording(tmp_path):
    source = ROOT / "content"
    for name in ("qa.json", "fixed_reply.json"):
        shutil.copy(source / name, tmp_path / name)
    qa = json.loads((tmp_path / "qa.json").read_text())
    qa[0]["answer"] += "文字已更改。"
    (tmp_path / "qa.json").write_text(json.dumps(qa))
    with pytest.raises(ValueError, match="copy"):
        FixedReply(tmp_path)
    shutil.copy(source / "qa.json", tmp_path / "qa.json")
    manifest = json.loads((tmp_path / "fixed_reply.json").read_text())
    manifest["audio"]["sha256"] = "0" * 64
    (tmp_path / "fixed_reply.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="audio"):
        FixedReply(tmp_path)


@pytest.mark.parametrize("expert", ["sally", "robin-li"])
def test_all_registered_phrasings_are_deterministic_even_when_classifier_is_down(expert):
    fixed = content(expert).fixed_reply
    class Broken(Chat):
        async def classify_reply(self, messages):
            raise AssertionError("Exact questions must not depend on a model")
    for question in fixed.aliases:
        assert asyncio.run(fixed.select("  " + question + "？\n", Broken())) is fixed


def test_classification_failure_and_timeout_fall_back():
    fixed = content("sally").fixed_reply
    class Broken:
        async def classify_reply(self, messages):
            raise RuntimeError("test-only upstream failure")
    class Slow:
        async def classify_reply(self, messages):
            await asyncio.sleep(60)
    assert asyncio.run(fixed.select("未登记的问题", Broken())) is None
    assert asyncio.run(fixed.select("未登记的问题", Slow(), timeout=0.01)) is None


@pytest.mark.parametrize("expert", ["sally", "robin-li"])
def test_http_asset_matches_manifest_and_config_advertises_fixed_audio(expert):
    import hashlib
    from fastapi.testclient import TestClient
    from server.main import create_app
    fixed = content(expert).fixed_reply
    app = create_app(Settings(allowed_hosts=("testserver",)), Providers(llm=Chat()))
    with TestClient(app) as client:
        config = client.get("/api/config", params={"expert_id": expert}).json()
        assert config["fixed_audio"] is True and config["capabilities"]["tts"] is False
        response = client.get(fixed.audio_url)
        assert response.status_code == 200 and response.content[:4] == b"RIFF"
        assert fixed.audio_url.endswith(hashlib.sha256(response.content).hexdigest()[:12] + ".wav")


@pytest.mark.parametrize("speak", [False, True])
def test_fake_stream_is_small_exact_deltas_and_finishes_within_seven_seconds(speak, skip_display_delays):
    async def run():
        s = session("sally", Chat(), ForbiddenTTS())
        fixed = s.content.fixed_reply
        await s.generate(s.new_turn(), fixed.question, speak=speak)
        deltas = [e["text"] for e in s.ws.events if e["type"] == "reply.delta"]
        assert "".join(deltas) == fixed.answer
        assert len(deltas) > 30 and all(1 <= len(d) <= 3 for d in deltas)
        assert sum(call.args[0] for call in skip_display_delays.await_args_list) == pytest.approx(6.0)
        if speak:
            types = [e["type"] for e in s.ws.events]
            assert types.index("audio.file") < types.index("reply.delta", types.index("reply.delta") + 1)
    asyncio.run(run())


def test_interrupt_stops_fake_stream_and_never_commits_unplayed_tail(monkeypatch):
    async def run():
        entered = asyncio.Event()
        async def waiting(_):
            entered.set()
            await asyncio.sleep(60)
        monkeypatch.setattr("server.session.pause_fixed_stream", waiting)
        s = session("sally", Chat(), ForbiddenTTS())
        s.started = True
        await s.handle({"type": "input.text", "text": s.content.fixed_reply.question, "speak": True})
        task = s.task
        await entered.wait()
        assert len(reply(s)) == 3
        await s.stop()
        assert task.cancelled() and len(reply(s)) == 3
        assert not any(m["role"] == "assistant" for m in s.history)
    asyncio.run(run())
