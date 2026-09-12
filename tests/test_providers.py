import asyncio
import base64
import gzip
import json
import struct

import httpx
import pytest

from server.providers import (OpenAIChat, ProviderError, Providers, Transcript, VolcASR, VolcTTS,
                              asr_packet, parse_asr_packet, speech_headers)
from server.settings import Settings


class SplitBytes(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data
    async def __aiter__(self):
        for i in range(0, len(self.data), 3):
            yield self.data[i:i + 3]


def run_collect(iterator):
    async def collect():
        return [item async for item in iterator]
    return asyncio.run(collect())


def response_packet(payload, flags=0, gzip_body=True):
    data = json.dumps(payload).encode()
    if gzip_body:
        data = gzip.compress(data)
    raw = bytes((0x11, 0x90 | flags, 0x11 if gzip_body else 0x10, 0))
    if flags & 1:
        raw += struct.pack(">i", -2 if flags & 2 else 2)
    return raw + struct.pack(">I", len(data)) + data


def test_chat_stream_handles_arbitrary_network_boundaries():
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(200, stream=SplitBytes(
            'data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\r\n\r\n'
            'data: {"choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n'
            'data: [DONE]\n\n'.encode()))
    settings = Settings(llm_api_key="unit-test-key", llm_model="unit-model")
    output = run_collect(OpenAIChat(settings, httpx.MockTransport(handler)).stream([{"role": "user", "content": "test"}]))
    assert output == ["你", "好"]
    assert seen[0].headers["authorization"] == "Bearer unit-test-key"
    assert json.loads(seen[0].content)["stream"] is True
    assert json.loads(seen[0].content)["thinking"] == {"type": "disabled"}


def test_chat_rejects_truncated_upstream_stream():
    transport = httpx.MockTransport(lambda r: httpx.Response(200, content=b'data: {"choices":[]}\n\n'))
    with pytest.raises(ProviderError):
        run_collect(OpenAIChat(Settings(), transport).stream([]))


def test_speech_auth_new_and_legacy_header_names():
    s = Settings(asr_api_key="new-asr", tts_api_key="new-tts", asr_app_id="old", tts_app_id="old")
    assert speech_headers(s, "asr")["X-Api-Key"] == "new-asr"
    assert speech_headers(s, "tts")["X-Api-Key"] == "new-tts"
    assert "X-Api-App-Key" not in speech_headers(s, "asr")
    s.asr_api_key = s.tts_api_key = ""
    assert speech_headers(s, "asr")["X-Api-App-Key"] == "old"
    assert speech_headers(s, "tts")["X-Api-App-Id"] == "old"
    assert Providers.configured(Settings()).capabilities == {"llm": False, "asr": False, "tts": False}
    assert Providers.configured(Settings(asr_api_key="x")).capabilities["asr"]


@pytest.mark.parametrize("flags", [0, 1, 2, 3])
def test_asr_sequence_and_last_flag_are_independent(flags):
    payload = {"result": {"text": "测试", "utterances": [{"definite": True}]}}
    result, final = parse_asr_packet(response_packet(payload, flags))
    assert result == payload
    assert final == bool(flags & 2)


def test_asr_request_headers_and_pcm_payload():
    packet = asr_packet(b"\x00\x01", audio=True, final=True)
    assert packet[:4] == bytes((0x11, 0x22, 0x01, 0))
    assert struct.unpack(">I", packet[4:8])[0] == len(packet[8:])
    assert gzip.decompress(packet[8:]) == b"\x00\x01"


def test_asr_rejects_protocol_errors_and_payload_mismatch():
    with pytest.raises(ProviderError):
        parse_asr_packet(bytes((0x11, 0xF0, 0x11, 0)) + b"12345678")
    with pytest.raises(ProviderError):
        parse_asr_packet(response_packet({"result": {}})[:-1])


def test_tts_base64_stream_and_documented_completion():
    seen = []
    data = b"\x00\x01\x02\x03"
    def handler(request):
        seen.append(request)
        body = ("event: 352\ndata: " + json.dumps({"code": 0, "data": base64.b64encode(data).decode()})
                + '\n\nevent: 152\ndata: {"code":20000000,"data":null}\n\n')
        return httpx.Response(200, stream=SplitBytes(body.encode()))
    adapter = VolcTTS(Settings(tts_api_key="test-only"), httpx.MockTransport(handler))
    assert b"".join(run_collect(adapter.synthesize("测试"))) == data
    request = json.loads(seen[0].content)
    assert request["req_params"]["audio_params"] == {"format": "pcm", "sample_rate": 24000}
    assert request["req_params"]["text"] == "测试"


@pytest.mark.parametrize("body", [b'data: {"code":45000000}\n\n', b'data: {"code":0,"data":"AAE="}\n\n'])
def test_tts_rejects_error_and_missing_completion(body):
    adapter = VolcTTS(Settings(), httpx.MockTransport(lambda r: httpx.Response(200, content=body)))
    with pytest.raises(ProviderError):
        run_collect(adapter.synthesize("测试"))


def test_asr_rechunks_pcm_and_waits_for_terminal_packet_not_definite_utterance():
    class Socket:
        def __init__(self):
            self.sent = []
            self.last = asyncio.Event()
            self.count = 0
        async def send(self, raw):
            self.sent.append(raw)
            if raw[1] & 2:
                self.last.set()
        async def recv(self):
            self.count += 1
            if self.count == 1:
                return response_packet({"result": {"text": "第一句", "utterances": [{"definite": True}]}}, 1)
            await self.last.wait()
            return response_packet({"result": {"text": "完整问题"}}, 3)
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return False
    async def scenario():
        socket = Socket()
        async def audio():
            yield b"\x00\x01" * 3500
        adapter = VolcASR(Settings(asr_api_key="test-only"), connector=lambda *a, **kw: socket)
        transcripts = [item async for item in adapter.transcribe(audio())]
        assert transcripts == [Transcript("第一句", False), Transcript("完整问题", True)]
        assert json.loads(gzip.decompress(socket.sent[0][8:]))["audio"]["format"] == "pcm"
        assert len(gzip.decompress(socket.sent[1][8:])) == 6400
        assert len(gzip.decompress(socket.sent[2][8:])) == 600
        assert socket.sent[2][1] & 2
    asyncio.run(scenario())


def test_asr_diagnostics_keep_secrets_out_of_browser_errors():
    from server.providers import asr_failure_details
    from websockets.exceptions import InvalidStatus
    from websockets.http11 import Response
    from websockets.datastructures import Headers
    exc = InvalidStatus(Response(403, "private-key-sentinel", Headers({
        "X-Api-Status-Code": "45000030", "X-Api-Message": "private-key-sentinel"}), body=b"private-key-sentinel"))
    result = asr_failure_details(exc)
    assert result["diagnostic"] == "HTTP_403/UPSTREAM_45000030"
    assert "private-key-sentinel" not in str(result)
    assert "private-key-sentinel" not in str(asr_failure_details(RuntimeError("private-key-sentinel")))
    packet = bytes((0x11, 0xf0, 0x11, 0)) + struct.pack(">I", 45000030) + b"private-key-sentinel"
    with pytest.raises(ProviderError) as caught:
        parse_asr_packet(packet)
    assert asr_failure_details(caught.value)["diagnostic"] == "ASR_PROTOCOL/UPSTREAM_45000030"


def test_tts_http_error_keeps_only_status_and_fixed_reason():
    from server.providers import generation_failure_details
    adapter = VolcTTS(Settings(), httpx.MockTransport(lambda r: httpx.Response(403, json={
        "code": 45000030, "message": "requested resource not granted private-key-sentinel"})))
    with pytest.raises(ProviderError) as caught:
        run_collect(adapter.synthesize("测试"))
    result = generation_failure_details(caught.value, "TTS")
    assert result["diagnostic"] == "TTS/HTTP_403/UPSTREAM_45000030/RESOURCE_ACCESS"
    assert "private-key-sentinel" not in str(result)


def test_tts_stream_error_retains_numeric_code_without_raw_message():
    from server.providers import generation_failure_details
    adapter = VolcTTS(Settings(), httpx.MockTransport(lambda r: httpx.Response(200,
        content=b'data: {"code":45000000,"message":"speaker not found private-key-sentinel"}\n\n')))
    with pytest.raises(ProviderError) as caught:
        run_collect(adapter.synthesize("测试"))
    result = generation_failure_details(caught.value, "TTS")
    assert result["diagnostic"] == "TTS/UPSTREAM_45000000/VOICE_NOT_FOUND"
    assert "private-key-sentinel" not in str(result)
