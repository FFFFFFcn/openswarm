"""ASGI entrypoint."""

from app.factory import build_app

app = build_app()

if __name__ == "__main__":
    import uvicorn

    from app.core.config import get_settings

    _settings = get_settings()
    uvicorn.run(app, host=_settings.app_host, port=_settings.app_port)

