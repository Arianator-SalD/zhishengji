from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .context import Content
from .access import DemoAccess
from .providers import Providers
from .session import VoiceSession
from .settings import ROOT, Settings


def create_app(settings=None, providers=None, content_dir=None, static_dir=None):
    settings = settings if settings is not None else Settings.from_env()
    providers = providers if providers is not None else Providers.configured(settings)
    content = Content(Path(content_dir) if content_dir else ROOT / "content")
    static = Path(static_dir) if static_dir else ROOT / "static"
    app = FastAPI(title="职升机语音演示", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(DemoAccess, password=settings.demo_access_password,
                       required=settings.require_access_password)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.allowed_hosts))
    active_sessions = 0

    @app.get("/health")
    async def health():
        return {"status": "ok", "capabilities": providers.capabilities}

    @app.get("/api/config")
    async def config():
        return {"capabilities": providers.capabilities, "qa": content.qa, "profile": content.profile}

    @app.websocket("/ws/voice")
    async def voice(socket: WebSocket):
        nonlocal active_sessions
        origin = socket.headers.get("origin")
        if origin:
            parsed = urlparse(origin)
            same = (parsed.scheme in ("http", "https") and parsed.netloc == socket.headers.get("host")
                    and not parsed.username and parsed.path in ("", "/") and not parsed.query and not parsed.fragment)
            if not same and origin not in settings.allowed_origins:
                await socket.close(code=1008)
                return
        if active_sessions >= 3:
            await socket.close(code=1013)
            return
        active_sessions += 1
        try:
            await socket.accept()
            await VoiceSession(socket, providers, settings, content).run()
        finally:
            active_sessions -= 1

    @app.get("/")
    async def index():
        return FileResponse(static / "index.html")

    app.mount("/static", StaticFiles(directory=static), name="static")
    return app


app = create_app()
