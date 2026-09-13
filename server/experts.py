"""Allowlisted expert bundles; credentials are shared, identity and voice are not."""
from dataclasses import dataclass, replace
from pathlib import Path

from .context import Content
from .providers import Providers
from .settings import ROOT, Settings


@dataclass(frozen=True)
class Expert:
    id: str
    name: str
    content: Content
    providers: Providers
    default_use_demo_profile: bool

    def public_config(self):
        return {
            "expert_id": self.id,
            "name": self.name,
            "default_use_demo_profile": self.default_use_demo_profile,
            "capabilities": self.providers.capabilities,
            "fixed_audio": self.content.fixed_reply is not None,
            "qa": self.content.qa,
            "profile": self.content.profile,
        }


def build_experts(settings: Settings, providers=None, content_dir=None):
    root = Path(content_dir) if content_dir else ROOT / "content"
    # A single injected provider bundle supports existing controlled test harnesses.
    # A mapping allows tests to inspect each expert's provider independently.
    if isinstance(providers, dict):
        sally_providers, robin_providers = providers["sally"], providers["robin-li"]
    elif providers is not None:
        sally_providers = robin_providers = providers
    else:
        sally_providers = Providers.configured(settings)
        robin_settings = replace(settings, tts_speaker=settings.robin_tts_speaker,
                                 tts_resource_id=settings.robin_tts_resource_id,
                                 tts_speech_rate=settings.robin_tts_speech_rate)
        robin_tts = Providers.configured(robin_settings).tts
        robin_providers = Providers(sally_providers.llm, sally_providers.asr, robin_tts)
    return {
        "sally": Expert("sally", "Sally", Content(root), sally_providers, True),
        "robin-li": Expert("robin-li", "李彦宏",
                           Content(root / "robin-li", name="李彦宏"),
                           robin_providers, True),
    }
