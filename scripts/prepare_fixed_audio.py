"""Explicit, one-off capture of approved demo copy; never runs in the request path.

Use a configured demo server to generate audio when local vendor credentials are
unavailable. Verify returned copy AND every complete TTS segment before saving.
No credentials or arbitrary user conversations are read or recorded.
"""
import argparse
import asyncio
import hashlib
import io
import json
from pathlib import Path
import re
import uuid
import wave

import websockets

ROOT = Path(__file__).resolve().parents[1]
SPECS = {
    "sally": {
        "id": "fixed-finance-to-product", "source": "qa.json", "source_id": "career_switch",
        "aliases": ["金融背景想转AI产品，有什么建议？", "我是金融专业，想转AI产品经理，怎么开始？", "金融转产品有什么具体建议？"],
        "intent": "金融背景学生初步考虑转产品／AI 产品，询问总体建议或如何开始探索；没有已经选定的具体项目或新的经历需要处理。",
    },
    "robin-li": {
        "id": "fixed-ai-non-consensus", "source": "stable_replies.json", "source_id": "application-driven-decade",
        "aliases": ["未来十年，你有哪些非共识的判断？", "你对AI有什么非共识的判断？", "关于AI，你有哪些非共识？", "对未来十年，你最坚定的判断是什么？"],
        "intent": "概述对 AI 或未来十年的非共识、与大众不同的坚定判断；整段回答是从 2023 年起强调应用驱动、应用层机会最大、希望未来验证观点。",
    },
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def compact(text):
    return re.sub(r"\s+", "", text)


async def capture(server, expert, answer):
    uri = server.replace("https://", "wss://").replace("http://", "ws://").rstrip("/")
    async with websockets.connect(uri + "/ws/voice?expert_id=" + expert,
                                  origin=server.rstrip("/"), proxy=None,
                                  open_timeout=20, max_size=4_000_000) as ws:
        await ws.send(json.dumps({"type": "session.start", "use_demo_profile": False}))
        while json.loads(await ws.recv())["type"] != "session.ready":
            pass
        request = uuid.uuid4().hex
        prompt = "请逐字输出下面的指定文稿，不要解释，不要增删或改写任何字词，也不要添加开场白、标题或引号。只输出文稿本身：\n" + answer
        await ws.send(json.dumps({"type": "input.text", "request_id": request,
                                  "text": prompt, "speak": True}))
        segments, text, current, rate = [], "", None, None
        async with asyncio.timeout(180):
            while True:
                event = await ws.recv()
                if isinstance(event, bytes):
                    if current is None or len(event) % 2:
                        raise ValueError("Unexpected PCM framing")
                    current["pcm"].extend(event)
                    continue
                event = json.loads(event)
                if event.get("request_id") != request:
                    continue
                kind = event["type"]
                if kind == "error":
                    raise ValueError("Demo provider returned " + event.get("code", "unknown"))
                if kind == "reply.delta":
                    text += event["text"]
                if kind == "audio.start":
                    if current or event["format"] != "pcm_s16le":
                        raise ValueError("Unexpected audio format")
                    if rate is not None and rate != event["sample_rate"]:
                        raise ValueError("Mixed sample rates")
                    rate = event["sample_rate"]
                    current = {"id": event["segment_id"], "text": event["text"], "pcm": bytearray()}
                if kind == "audio.end":
                    if current is None or current["id"] != event["segment_id"] or not current["pcm"]:
                        raise ValueError("Incomplete audio segment")
                    segments.append(current)
                    current = None
                if kind == "turn.end":
                    break
        if current is not None or not segments:
            raise ValueError("Missing complete audio")
        if compact(text) != compact(answer) or compact("".join(s["text"] for s in segments)) != compact(answer):
            raise ValueError("Generated copy differs from approved copy; no file written")
        pcm = b"".join(s["pcm"] for s in segments)
        stream = io.BytesIO()
        with wave.open(stream, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes(pcm)
        return stream.getvalue(), rate, len(pcm) / (rate * 2), len(segments)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True)
    parser.add_argument("--expert", required=True, choices=SPECS)
    args = parser.parse_args()
    if not args.server.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise ValueError("Use HTTPS or a local demo server")
    spec = SPECS[args.expert]
    directory = ROOT / "content" / ("robin-li" if args.expert == "robin-li" else "")
    source = next(c for c in json.loads((directory / spec["source"]).read_text()) if c["id"] == spec["source_id"])
    audio, rate, duration, count = await capture(args.server, args.expert, source["answer"])
    audio_hash = digest(audio)
    filename = args.expert + "-" + spec["id"] + "-" + audio_hash[:12] + ".wav"
    output = ROOT / "static/fixed-audio" / filename
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(audio)
    manifest = {**spec, "expert_id": args.expert, "question": source["question"],
                "answer_sha256": digest(source["answer"].encode()),
                "audio": {"url": "/static/fixed-audio/" + filename, "sha256": audio_hash,
                          "sample_rate": rate, "duration_seconds": duration},
                "production": {"method": "one-off demo WebSocket TTS capture", "segments": count,
                               "copy_check": "exact after whitespace removal", "human_listening_verified": False}}
    (directory / "fixed_reply.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"expert": args.expert, "duration_seconds": round(duration, 3),
                      "bytes": len(audio), "segments": count, "file": str(output)}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
