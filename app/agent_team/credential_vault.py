"""Credential persistence for the embedded (fakeredis) deployment.

AgentScope stores model credentials in its Redis-backed storage. In
embedded mode that storage is an in-process fakeredis instance, so every
credential vanishes on restart and the ``credential_id`` held by the
frontend becomes invalid.

This module mirrors each credential write to a local JSON vault (inside
the gitignored ``.data/`` directory) and replays the vault into Redis on
startup, keeping the original ids so previously issued ``credential_id``
values stay valid across restarts.

The vault intentionally stores plaintext secrets: it lives on the same
machine as the ``.env`` file that already carries the data API key, and the
deployment target is a single-user local/desktop app.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from agentscope.app.storage import CredentialRecord, RedisStorage
from agentscope.credential import CredentialFactory

logger = logging.getLogger(__name__)


class CredentialVault:
    """File-backed mirror of credential records (plaintext, local-only)."""

    def __init__(self, path: Path) -> None:
        self._path = path

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> list[CredentialRecord]:
        """Return all mirrored records; a missing/corrupt vault is empty."""
        if not self._path.exists():
            return []
        try:
            payload = json.loads(self._path.read_text("utf-8"))
            entries = (
                payload.get("credentials", [])
                if isinstance(payload, dict)
                else []
            )
            return [
                CredentialRecord.model_validate(entry)
                for entry in entries
                if isinstance(entry, dict)
            ]
        except (OSError, ValueError) as exc:
            logger.warning(
                "Credential vault %s is unreadable (%s); ignoring it.",
                self._path,
                exc,
            )
            return []

    def save(self, record: CredentialRecord) -> None:
        """Insert or replace a record, then flush atomically."""
        records = [item for item in self.load() if item.id != record.id]
        records.append(record)
        self._write(records)

    def remove(self, credential_id: str) -> None:
        """Drop a record by id and flush atomically."""
        records = [item for item in self.load() if item.id != credential_id]
        self._write(records)

    def _write(self, records: list[CredentialRecord]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "credentials": [
                json.loads(item.model_dump_json()) for item in records
            ],
        }
        tmp = self._path.with_name(self._path.name + ".tmp")
        tmp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp, self._path)


class PersistentCredentialStorage(RedisStorage):
    """RedisStorage that mirrors credentials to a local JSON vault."""

    def __init__(self, *, vault_path: Path, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.vault = CredentialVault(vault_path)

    async def upsert_credential(self, user_id: str, credential_data: Any) -> str:
        credential_id = await super().upsert_credential(
            user_id,
            credential_data,
        )
        record = await self.get_credential(user_id, credential_id)
        if record is not None:
            self.vault.save(record)
        return credential_id

    async def delete_credential(self, user_id: str, credential_id: str) -> bool:
        deleted = await super().delete_credential(user_id, credential_id)
        if deleted:
            self.vault.remove(credential_id)
        return deleted

    async def restore_credentials(self) -> int:
        """Replay vault entries into Redis, preserving original ids.

        Returns:
            The number of credentials successfully restored.
        """
        restored = 0
        for record in self.vault.load():
            try:
                credential = CredentialFactory.from_dict(record.data)
            except Exception as exc:  # noqa: BLE001 - skip bad entries
                logger.warning(
                    "Skipping vault credential %r: %s",
                    record.id,
                    exc,
                )
                continue
            credential.id = record.id
            # Bypass the mirroring override; the vault already holds it.
            await RedisStorage.upsert_credential(
                self,
                record.user_id,
                credential,
            )
            restored += 1
        if restored:
            logger.info(
                "Restored %d credential(s) from %s",
                restored,
                self.vault.path,
            )
        return restored
