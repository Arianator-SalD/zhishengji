"""Local browser integration only: deliberately synthetic providers, never production."""
import asyncio
from server.main import create_app
from server.providers import Providers, Transcript
from server.settings import Settings

class LLM:
    async def stream(self, messages):
        name = '李彦宏' if '李彦宏 AI 分身' in messages[0]['content'] else 'Sally'
        for text in [f'这是{name}的浏览器集成测试。', '这段文字用于检验流式传输和两轮对话。']:
            await asyncio.sleep(0.08)
            yield text

class ASR:
    async def transcribe(self, audio):
        async for _ in audio:
            yield Transcript('测试录音', False)
        yield Transcript('测试录音问题', True)

class TTS:
    sample_rate = 24000
    async def synthesize(self, text):
        for _ in range(4):
            await asyncio.sleep(0.04)
            yield bytes(2400)

app = create_app(settings=Settings(), providers=Providers(LLM(), ASR(), TTS()))
