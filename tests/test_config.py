from __future__ import annotations

from app.core.config import Settings


def test_comma_separated_origin_and_host_settings(monkeypatch) -> None:
    monkeypatch.setenv(
        "OPENSWARM_ALLOWED_ORIGINS",
        "http://127.0.0.1:8000,http://localhost:8000",
    )
    monkeypatch.setenv("OPENSWARM_ALLOWED_HOSTS", "127.0.0.1,localhost")
    settings = Settings(_env_file=None)
    assert settings.allowed_origins == [
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ]
    assert settings.allowed_hosts == ["127.0.0.1", "localhost"]


def test_redfox_key_requires_exact_environment_name(monkeypatch) -> None:
    monkeypatch.delenv("REDFOX_API_KEY", raising=False)
    monkeypatch.setenv("OPENSWARM_REDFOX_API_KEY", "ignored-test-key")
    settings = Settings(_env_file=None)
    assert settings.redfox_api_key is None

    monkeypatch.setenv("REDFOX_API_KEY", "accepted-test-key")
    settings = Settings(_env_file=None)
    assert settings.redfox_api_key is not None
    assert settings.redfox_api_key.get_secret_value() == "accepted-test-key"
