from dataclasses import dataclass, field
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Settings:
    llm_url: str = "https://api.deepseek.com/chat/completions"
    llm_api_key: str = field(default="", repr=False)
    llm_model: str = "deepseek-flash"
    demo_access_password: str = field(default="", repr=False)
    require_access_password: bool = False
    asr_api_key: str = field(default="", repr=False)
    asr_app_id: str = ""
    asr_access_token: str = field(default="", repr=False)
    asr_url: str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
    asr_resource_id: str = "volc.seedasr.sauc.duration"
    tts_api_key: str = field(default="", repr=False)
    tts_app_id: str = ""
    tts_access_token: str = field(default="", repr=False)
    tts_url: str = "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse"
    tts_resource_id: str = "seed-tts-2.0"
    tts_speaker: str = "zh_female_vv_uranus_bigtts"
    tts_sample_rate: int = 24000
    provider_timeout: float = 45
    max_audio_seconds: float = 60
    max_text_chars: int = 2000
    max_reply_chars: int = 6000
    max_audio_frame_bytes: int = 32768
    max_audio_queue: int = 32
    max_history_messages: int = 24
    allowed_hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "[::1]")
    allowed_origins: tuple[str, ...] = ()

    @classmethod
    def from_env(cls):
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
        values = {}
        for name in cls.__dataclass_fields__:
            key = "VOLC_" + name.upper() if name.startswith(("asr_", "tts_")) else name.upper()
            key = {"provider_timeout": "PROVIDER_TIMEOUT_SECONDS"}.get(name, key)
            value = os.getenv(key)
            if value is None:
                continue
            if name in {"allowed_hosts", "allowed_origins"}:
                values[name] = tuple(x.strip().rstrip("/") for x in value.split(",") if x.strip())
            elif name == "require_access_password":
                values[name] = value.lower() in {"1", "true", "yes"}
            elif name in {"provider_timeout", "max_audio_seconds"}:
                values[name] = max(1, min(float(value), 300))
            elif isinstance(getattr(cls(), name), int):
                values[name] = max(1, int(value))
            else:
                values[name] = value.strip()
        # Render supplies the assigned public hostname; keep local development valid.
        render_host = os.getenv("RENDER_EXTERNAL_HOSTNAME", "").strip()
        if os.getenv("RENDER") == "true" or render_host:
            values["require_access_password"] = True
        if render_host and "/" not in render_host and ":" not in render_host:
            hosts = values.get("allowed_hosts", cls().allowed_hosts)
            values["allowed_hosts"] = tuple(dict.fromkeys((*hosts, render_host)))
        return cls(**values)
