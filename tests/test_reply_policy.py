"""Deterministic routing/transport tests; opt-in live semantic evaluation below."""
import asyncio
import json
import os

import httpx
import pytest

from server.context import Content
from server.providers import OpenAIChat, Providers, Transcript
from server.reply_policy import normalize_question
from server.session import VoiceSession
from server.settings import ROOT, Settings


CARDS = json.loads((ROOT / "content/robin-li/stable_replies.json").read_text())
CASES = json.loads((ROOT / "tests/fixtures/robin_reply_semantics.json").read_text())


def policy():
    return Content(ROOT / "content/robin-li", name="李彦宏").reply_policy


class Chat:
    def __init__(self, decision=None):
        self.decision = decision or {"id": "none"}
        self.classified, self.generated = [], []
        self.temperatures = []

    async def classify_reply(self, messages):
        self.classified.append(messages)
        return self.decision

    async def stream(self, messages, *, temperature=0.6):
        self.generated.append(messages)
        self.temperatures.append(temperature)
        yield "根据当前问题继续讨论。"


class Socket:
    def __init__(self):
        self.events = []

    async def send_json(self, event):
        self.events.append(event)

    async def send_bytes(self, chunk):
        self.events.append({"type": "binary", "bytes": chunk})


class Speech:
    sample_rate = 24000

    def __init__(self):
        self.texts = []

    async def synthesize(self, text):
        self.texts.append(text)
        yield b"\x00\x01" * 4


def session(chat, expert="robin-li", tts=None, asr=None):
    directory = ROOT / "content" / ("robin-li" if expert == "robin-li" else "")
    return VoiceSession(Socket(), Providers(llm=chat, tts=tts, asr=asr), Settings(),
                        Content(directory), expert_id=expert)


def reply(s):
    return "".join(e["text"] for e in s.ws.events if e["type"] == "reply.delta")


@pytest.mark.parametrize("card,question", [(c, q) for c in CARDS for q in [c["question"], *c["aliases"]]])
def test_even_original_and_alias_questions_use_model_routing(card, question):
    chat = Chat({"id": card["id"]})
    selected = asyncio.run(policy().select("  " + question.replace("？", "?") + "\n", chat))
    assert selected == card
    assert len(chat.classified) == 1 and not chat.generated


def test_copy_preserves_conditional_capabilities_and_application_thesis():
    digital, applications = (c["answer"] for c in CARDS)
    assert all(x in digital for x in ("降低", "门槛", "声音", "表情", "陪伴", "若", "视觉感知"))
    assert all(x in applications for x in ("2023", "应用驱动", "创造价值", "机会最大的是在应用层", "不在模型层、不在芯片层", "我希望未来很多年以后"))
    assert all(100 <= len(c["answer"]) <= 230 for c in CARDS)


@pytest.mark.parametrize("decision", [None, [], {}, {"id": []}, {"id": "other"},
                                    {"id": "none"}, {"id": CARDS[0]["id"], "extra": True}])
def test_invalid_or_uncertain_decision_falls_back(decision):
    chat = Chat()
    chat.decision = decision
    assert asyncio.run(policy().select("未知的新问法", chat)) is None


def test_semantic_selection_uses_bounded_recent_history_and_allowlisted_card():
    chat = Chat({"id": CARDS[0]["id"]})
    text = CASES[0]["text"]
    assert normalize_question(text) not in policy().aliases
    history = [{"role": "user", "content": "old-sentinel"}]*3 + [
        {"role": "assistant", "content": "近期上下文"*500}]*4
    assert asyncio.run(policy().select(text, chat, history=history)) == CARDS[0]
    messages = chat.classified[0]
    assert [m["role"] for m in messages] == ["system", "user"]
    payload = json.loads(messages[-1]["content"])
    assert payload["question"] == text and len(payload["recent_history"]) == 4
    assert all(len(m["content"]) <= 1500 for m in payload["recent_history"])
    assert "old-sentinel" not in messages[-1]["content"]
    assert "林小北" not in messages[0]["content"]


def test_classification_timeout_failure_and_cancellation():
    class Broken:
        async def classify_reply(self, messages):
            raise RuntimeError("private upstream body")

    class Slow:
        async def classify_reply(self, messages):
            await asyncio.sleep(10)

    class Cancelled:
        async def classify_reply(self, messages):
            raise asyncio.CancelledError()

    assert asyncio.run(policy().select("未预设问法", Broken())) is None
    assert asyncio.run(policy().select("未预设问法", Slow(), timeout=0.01)) is None
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(policy().select("未预设问法", Cancelled()))


@pytest.mark.parametrize("voice,profile", [(False, False), (False, True), (True, False), (True, True)])
@pytest.mark.parametrize("card", CARDS, ids=[c["id"] for c in CARDS])
def test_text_and_asr_both_generate_from_selected_strategy(voice, profile, card):
    # The application overview is now a frozen answer. Specific follow-ups must
    # still use the existing strategy/generation branch rather than replay it.
    question = (card["question"] if card["id"] == CARDS[0]["id"]
                else "应用层的护城河是什么，模型替代应用的风险怎么考虑？")
    class ASR:
        async def transcribe(self, audio):
            async for _ in audio:
                pass
            yield Transcript(question, True)

    async def run():
        chat, tts = Chat({"id": card["id"]}), Speech()
        s = session(chat, tts=tts, asr=ASR())
        s.use_demo_profile = profile
        turn = s.new_turn("demo-request")
        if voice:
            queue = asyncio.Queue()
            await queue.put(b"\x00\x01")
            await queue.put(None)
            await s.recognize(turn, queue)
            for i in range(len(turn.segments)):
                s.acknowledge({"turn_id": turn.id, "segment_id": i})
            assert "".join(tts.texts) == "根据当前问题继续讨论。"
            assert any(e["type"] == "binary" for e in s.ws.events)
        else:
            await s.generate(turn, question, speak=False)
        assert reply(s) == "根据当前问题继续讨论。"
        assert s.history[-1]["role"] == "assistant"
        assert s.history[-1]["content"] == "根据当前问题继续讨论。"
        assert len(chat.generated) == 1 and len(chat.classified) == 2
        assert chat.temperatures == [0.2]
        prompt = chat.generated[0][0]["content"]
        assert card["id"] in prompt and "不是要逐字照读的脚本" in prompt
        assert all(boundary in prompt for boundary in card["boundaries"])
        if profile:
            assert "林小北" in prompt
        else:
            assert "林小北" not in prompt
        assert any(e["type"] == "turn.end" for e in s.ws.events)
        assert not any(e["type"] == "error" for e in s.ws.events)
    asyncio.run(run())


@pytest.mark.parametrize("card", CARDS, ids=[c["id"] for c in CARDS])
def test_semantic_hit_enters_session_with_generation(card):
    async def run():
        chat = Chat({"id": card["id"]})
        s = session(chat)
        question = next(c["text"] for c in CASES if c["expected"] == card["id"])
        await s.generate(s.new_turn(), question, speak=False)
        assert reply(s) != card["answer"]
        assert len(chat.classified) == 2 and len(chat.generated) == 1
    asyncio.run(run())


def test_nonmatching_followup_retains_history_and_user_correction():
    async def run():
        chat = Chat({"id": CARDS[0]["id"]})
        s = session(chat)
        await s.generate(s.new_turn(), CARDS[0]["question"], speak=False)
        chat.decision = {"id": "none"}
        correction = "我现在每周只有两小时，你说的门槛怎么验证？"
        await s.generate(s.new_turn(), correction, speak=False)
        assert len(chat.generated) == 2 and len(chat.classified) == 4
        assert chat.temperatures == [0.2, 0.6]
        messages = chat.generated[-1]
        assert messages[-1] == {"role": "user", "content": correction}
        assert messages[-2]["content"] == "根据当前问题继续讨论。"
        routing = json.loads(chat.classified[-1][-1]["content"])
        assert routing["recent_history"][-1]["content"] == messages[-2]["content"]
        assert routing["question"] == correction
        assert "尚未提供个人信息" in messages[0]["content"]
        assert "非本人逐字原话" in messages[0]["content"]
        assert "本轮已匹配观点参考卡" not in messages[0]["content"]
        assert s.history[-1]["content"] == "根据当前问题继续讨论。"
    asyncio.run(run())


def test_generation_failure_does_not_silently_read_reference_copy():
    class Broken(Chat):
        async def stream(self, messages, *, temperature=0.6):
            raise RuntimeError("test-only failure")
            yield "unreachable"

    async def run():
        s = session(Broken({"id": CARDS[0]["id"]}))
        await s.generate(s.new_turn(), CARDS[0]["question"], speak=False)
        assert reply(s) == ""
        assert any(e.get("code") == "GENERATION_FAILED" for e in s.ws.events)
    asyncio.run(run())


def test_sally_never_uses_robin_classification_or_copy():
    async def run():
        chat = Chat({"id": CARDS[1]["id"]})
        s = session(chat, expert="sally")
        await s.generate(s.new_turn(), CARDS[1]["question"], speak=False)
        assert len(chat.classified) == 1 and len(chat.generated) == 1
        assert "fixed-finance-to-product" in chat.classified[0][0]["content"]
        assert "application-driven-decade" not in chat.classified[0][0]["content"]
        assert chat.temperatures == [0.6]
        assert reply(s) == "根据当前问题继续讨论。"
        assert "application-driven-decade" not in chat.generated[0][0]["content"]
    asyncio.run(run())


def test_interrupt_cancels_pending_classification_without_late_output():
    async def run():
        entered = asyncio.Event()
        class Slow(Chat):
            async def classify_reply(self, messages):
                entered.set()
                await asyncio.sleep(10)
                return {"id": CARDS[0]["id"]}
        s = session(Slow())
        s.started = True
        await s.handle({"type": "input.text", "text": CASES[0]["text"], "speak": False})
        task = s.task
        await asyncio.wait_for(entered.wait(), 1)
        await s.stop(notify=True)
        assert task.cancelled()
        assert not reply(s) and s.turn is None
    asyncio.run(run())


@pytest.mark.parametrize("hostname", ["api.deepseek.com", "example.test"])
def test_real_adapter_json_contract_with_mock_http(hostname):
    def handler(request):
        body = json.loads(request.content)
        assert body["stream"] is False and body["temperature"] == 0
        assert body["response_format"] == {"type": "json_object"}
        assert body["max_tokens"] == 80
        assert ("thinking" in body) == (hostname == "api.deepseek.com")
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"id": CARDS[1]["id"]})}}]})
    llm = OpenAIChat(Settings(llm_url=f"https://{hostname}/chat/completions", llm_api_key="test-only"),
                     httpx.MockTransport(handler))
    assert asyncio.run(policy().select(CASES[4]["text"], llm)) == CARDS[1]


@pytest.mark.parametrize("body", [{"choices": []}, {"choices": [{"finish_reason": "length"}]},
    {"choices": [{"finish_reason": "stop", "message": {"content": "not JSON"}}]}])
def test_malformed_provider_result_falls_back(body):
    llm = OpenAIChat(Settings(), httpx.MockTransport(lambda r: httpx.Response(200, json=body)))
    assert asyncio.run(policy().select("未预设问法", llm)) is None


@pytest.mark.skipif(os.getenv("ROBIN_LIVE_EVAL") != "1", reason="Opt-in real DeepSeek evaluation requires configured LLM credentials")
@pytest.mark.parametrize("case", CASES, ids=[f"semantic-{i + 1}" for i in range(len(CASES))])
def test_live_unseen_semantic_questions(case):
    settings = Settings.from_env()
    assert settings.llm_api_key, "Live evaluation requested but LLM_API_KEY is not configured"
    p = policy()
    assert normalize_question(case["text"]) not in p.aliases
    expected = p.by_id.get(case["expected"])
    # Evaluate the actual classifier directly so provider failure cannot be counted
    # as a correct 'none'. Repeat to measure variation rather than a single lucky hit.
    async def run():
        llm = OpenAIChat(settings)
        for _ in range(3):
            async with asyncio.timeout(6):
                decision = await llm.classify_reply(p.classification_messages(case["text"], case.get("history", [])))
            assert decision == {"id": case["expected"]}
            assert p.by_id.get(decision["id"]) == expected
    asyncio.run(run())
