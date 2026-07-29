"""File-backed data API key store with env-var fallback.

The admin console writes the key here so the packaged desktop build
(which has no editable .env) can configure the data API at runtime. A
stored key always wins over the environment variable; clearing the
store falls back to the env value.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

from pydantic import SecretStr


class RedFoxKeyStore:
    def __init__(self, path: Path, env_key: SecretStr | None = None) -> None:
        self._path = path
        self._env_key = env_key
        self._lock = threading.Lock()
        self._stored: SecretStr | None = self._read_file()

    def _read_file(self) -> SecretStr | None:
        try:
            record = json.loads(self._path.read_text(encoding="utf-8"))
            value = str(record.get("api_key") or "").strip()
            return SecretStr(value) if value else None
        except (OSError, ValueError):
            return None

    @property
    def source(self) -> str | None:
        """Where the effective key comes from: "stored", "env" or None."""
        if self._stored:
            return "stored"
        if self._env_key and self._env_key.get_secret_value().strip():
            return "env"
        return None

    def get(self) -> SecretStr | None:
        """Effective key for RedFox clients; called on every request."""
        return self._stored or self._env_key

    def set(self, value: str) -> None:
        key = value.strip()
        if not key:
            raise ValueError("API key must not be empty.")
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(
                json.dumps({"api_key": key}, ensure_ascii=False),
                encoding="utf-8",
            )
            self._stored = SecretStr(key)

    def clear(self) -> None:
        with self._lock:
            self._path.unlink(missing_ok=True)
            self._stored = None
