"""SQLite repository for durable editorial state."""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator


JSON_COLUMNS = {
    "differentiators",
    "forbidden_topics",
    "content_pillars",
    "hashtags",
    "image_prompts",
    "compliance_notes",
}
_MIGRATION_LOCK = threading.Lock()


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class OperationsRepository:
    """Connection-per-operation repository suitable for a local single process."""

    def __init__(self, database_path: Path, migrations_dir: Path) -> None:
        self.database_path = database_path
        self.migrations_dir = migrations_dir

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def migrate(self) -> None:
        with _MIGRATION_LOCK, self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            # Migrations may rebuild parent tables (drop + rename); keep the
            # cascade machinery out of the way while they run.
            connection.execute("PRAGMA foreign_keys = OFF")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
            )
            applied = {
                row["version"]
                for row in connection.execute(
                    "SELECT version FROM schema_migrations",
                ).fetchall()
            }
            for migration in sorted(self.migrations_dir.glob("*.sql")):
                if migration.stem in applied:
                    continue
                version = migration.stem.replace("'", "''")
                applied_at = utc_now().replace("'", "''")
                sql = migration.read_text(encoding="utf-8")
                connection.executescript(
                    f"BEGIN IMMEDIATE;\n{sql}\n"
                    "INSERT INTO schema_migrations(version, applied_at) "
                    f"VALUES ('{version}', '{applied_at}');\nCOMMIT;",
                )

    @staticmethod
    def _decode(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        data = dict(row)
        for key in JSON_COLUMNS & data.keys():
            data[key] = json.loads(data[key])
        return data

    @staticmethod
    def _decode_many(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
        return [OperationsRepository._decode(row) for row in rows]  # type: ignore[misc]

    def _activity(
        self,
        connection: sqlite3.Connection,
        user_id: str,
        entity_type: str,
        entity_id: str,
        action: str,
        actor: str,
    ) -> None:
        connection.execute(
            "INSERT INTO activity_log "
            "(id, user_id, entity_type, entity_id, action, actor, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, user_id, entity_type, entity_id, action, actor, utc_now()),
        )

    def list_accounts(self, user_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM account_profiles WHERE user_id = ? "
                "ORDER BY created_at DESC",
                (user_id,),
            ).fetchall()
        return self._decode_many(rows)

    def get_account_by_id(
        self,
        user_id: str,
        account_id: str,
    ) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM account_profiles WHERE user_id = ? AND id = ?",
                (user_id, account_id),
            ).fetchone()
        return self._decode(row)

    def create_account(self, user_id: str, data: dict[str, Any]) -> dict[str, Any]:
        account_id = uuid.uuid4().hex
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO account_profiles
                    (id, user_id, account_name, niche, target_audience,
                     primary_goal, voice, differentiators, forbidden_topics,
                     red_id, follower_count, notes_count, intro, profile_url,
                     source, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    account_id,
                    user_id,
                    data["account_name"],
                    data["niche"],
                    data["target_audience"],
                    data["primary_goal"],
                    data["voice"],
                    json.dumps(data["differentiators"], ensure_ascii=False),
                    json.dumps(data["forbidden_topics"], ensure_ascii=False),
                    data["red_id"],
                    data["follower_count"],
                    data["notes_count"],
                    data["intro"],
                    data["profile_url"],
                    data["source"],
                    now,
                    now,
                ),
            )
            self._activity(connection, user_id, "account", account_id, "created", "user")
        return self.get_account_by_id(user_id, account_id)  # type: ignore[return-value]

    def update_account(
        self,
        user_id: str,
        account_id: str,
        data: dict[str, Any],
    ) -> dict[str, Any] | None:
        with self.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE account_profiles SET
                    account_name = ?, niche = ?, target_audience = ?,
                    primary_goal = ?, voice = ?, differentiators = ?,
                    forbidden_topics = ?, red_id = ?, follower_count = ?,
                    notes_count = ?, intro = ?, profile_url = ?, source = ?,
                    updated_at = ?
                WHERE user_id = ? AND id = ?
                """,
                (
                    data["account_name"],
                    data["niche"],
                    data["target_audience"],
                    data["primary_goal"],
                    data["voice"],
                    json.dumps(data["differentiators"], ensure_ascii=False),
                    json.dumps(data["forbidden_topics"], ensure_ascii=False),
                    data["red_id"],
                    data["follower_count"],
                    data["notes_count"],
                    data["intro"],
                    data["profile_url"],
                    data["source"],
                    utc_now(),
                    user_id,
                    account_id,
                ),
            )
            changed = cursor.rowcount > 0
            if changed:
                self._activity(connection, user_id, "account", account_id, "updated", "user")
        return self.get_account_by_id(user_id, account_id) if changed else None

    def delete_account(self, user_id: str, account_id: str) -> bool:
        """Delete an account and everything it owns.

        Drafts are removed before topics explicitly: the drafts.topic_id
        foreign key is ON DELETE RESTRICT, so relying on the account_id
        cascade alone could hit the restriction mid-cascade.
        """
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "DELETE FROM drafts WHERE user_id = ? AND account_id = ?",
                (user_id, account_id),
            )
            connection.execute(
                "DELETE FROM topics WHERE user_id = ? AND account_id = ?",
                (user_id, account_id),
            )
            connection.execute(
                "DELETE FROM strategies WHERE user_id = ? AND account_id = ?",
                (user_id, account_id),
            )
            cursor = connection.execute(
                "DELETE FROM account_profiles WHERE user_id = ? AND id = ?",
                (user_id, account_id),
            )
            deleted = cursor.rowcount > 0
            if deleted:
                self._activity(connection, user_id, "account", account_id, "deleted", "user")
        return deleted

    def create_strategy(
        self,
        user_id: str,
        account_id: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        strategy_id = uuid.uuid4().hex
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO strategies
                    (id, user_id, account_id, positioning, persona,
                     content_pillars, posting_rhythm, growth_plan, status,
                     created_by_agent, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    strategy_id,
                    user_id,
                    account_id,
                    data["positioning"],
                    data["persona"],
                    json.dumps(data["content_pillars"], ensure_ascii=False),
                    data["posting_rhythm"],
                    data["growth_plan"],
                    data["status"],
                    data.get("created_by_agent"),
                    now,
                    now,
                ),
            )
            self._activity(
                connection,
                user_id,
                "strategy",
                strategy_id,
                "created",
                data.get("created_by_agent") or "user",
            )
        return self.get_strategy(user_id, strategy_id)  # type: ignore[return-value]

    def get_strategy(self, user_id: str, strategy_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM strategies WHERE user_id = ? AND id = ?",
                (user_id, strategy_id),
            ).fetchone()
        return self._decode(row)

    def list_strategies(
        self,
        user_id: str,
        limit: int = 20,
        account_id: str | None = None,
    ) -> list[dict[str, Any]]:
        query = "SELECT * FROM strategies WHERE user_id = ?"
        params: list[Any] = [user_id]
        if account_id:
            query += " AND account_id = ?"
            params.append(account_id)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        with self.connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return self._decode_many(rows)

    def update_strategy(
        self,
        user_id: str,
        strategy_id: str,
        changes: dict[str, Any],
        expected_status: str,
    ) -> dict[str, Any] | None:
        if not changes:
            return self.get_strategy(user_id, strategy_id)
        values = {**changes, "updated_at": utc_now()}
        assignments = ", ".join(f"{key} = ?" for key in values)
        with self.connect() as connection:
            cursor = connection.execute(
                f"UPDATE strategies SET {assignments} "
                "WHERE user_id = ? AND id = ? AND status = ?",
                [*values.values(), user_id, strategy_id, expected_status],
            )
            changed = cursor.rowcount > 0
            if changed:
                self._activity(connection, user_id, "strategy", strategy_id, "updated", "user")
        return self.get_strategy(user_id, strategy_id) if changed else None

    def create_topic(
        self,
        user_id: str,
        account_id: str,
        data: dict[str, Any],
        actor: str = "user",
    ) -> dict[str, Any]:
        topic_id = uuid.uuid4().hex
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO topics
                    (id, user_id, account_id, title, angle, pillar,
                     audience_need, hook, note_format, score, rationale,
                     hashtags, source_notes, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    topic_id,
                    user_id,
                    account_id,
                    data["title"],
                    data["angle"],
                    data["pillar"],
                    data["audience_need"],
                    data["hook"],
                    data["note_format"],
                    data["score"],
                    data["rationale"],
                    json.dumps(data["hashtags"], ensure_ascii=False),
                    data["source_notes"],
                    data["status"],
                    now,
                    now,
                ),
            )
            self._activity(connection, user_id, "topic", topic_id, "created", actor)
        return self.get_topic(user_id, topic_id)  # type: ignore[return-value]

    def get_topic(self, user_id: str, topic_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM topics WHERE user_id = ? AND id = ?",
                (user_id, topic_id),
            ).fetchone()
        return self._decode(row)

    def list_topics(
        self,
        user_id: str,
        status: str | None = None,
        limit: int = 50,
        account_id: str | None = None,
    ) -> list[dict[str, Any]]:
        query = "SELECT * FROM topics WHERE user_id = ?"
        params: list[Any] = [user_id]
        if status:
            query += " AND status = ?"
            params.append(status)
        if account_id:
            query += " AND account_id = ?"
            params.append(account_id)
        query += " ORDER BY score DESC, created_at DESC LIMIT ?"
        params.append(limit)
        with self.connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return self._decode_many(rows)

    def update_topic(
        self,
        user_id: str,
        topic_id: str,
        changes: dict[str, Any],
        actor: str = "user",
        expected_status: str | None = None,
    ) -> dict[str, Any] | None:
        if not changes:
            return self.get_topic(user_id, topic_id)
        values = dict(changes)
        if "hashtags" in values:
            values["hashtags"] = json.dumps(values["hashtags"], ensure_ascii=False)
        values["updated_at"] = utc_now()
        assignments = ", ".join(f"{key} = ?" for key in values)
        with self.connect() as connection:
            where = "WHERE user_id = ? AND id = ?"
            params: list[Any] = [*values.values(), user_id, topic_id]
            if expected_status is not None:
                where += " AND status = ?"
                params.append(expected_status)
            cursor = connection.execute(f"UPDATE topics SET {assignments} {where}", params)
            changed = cursor.rowcount > 0
            if changed:
                self._activity(connection, user_id, "topic", topic_id, "updated", actor)
        return self.get_topic(user_id, topic_id) if changed else None

    def create_draft(
        self,
        user_id: str,
        account_id: str,
        data: dict[str, Any],
        actor: str = "user",
        expected_topic_status: str | None = None,
    ) -> dict[str, Any] | None:
        draft_id = uuid.uuid4().hex
        now = utc_now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if expected_topic_status is not None:
                cursor = connection.execute(
                    "UPDATE topics SET status = 'drafting', updated_at = ? "
                    "WHERE user_id = ? AND id = ? AND status = ?",
                    (now, user_id, data["topic_id"], expected_topic_status),
                )
                if cursor.rowcount == 0:
                    return None
            connection.execute(
                """
                INSERT INTO drafts
                    (id, user_id, account_id, topic_id, title, cover_text,
                     body, hashtags, image_prompts, compliance_notes, status,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    draft_id,
                    user_id,
                    account_id,
                    data["topic_id"],
                    data["title"],
                    data["cover_text"],
                    data["body"],
                    json.dumps(data["hashtags"], ensure_ascii=False),
                    json.dumps(data["image_prompts"], ensure_ascii=False),
                    json.dumps(data["compliance_notes"], ensure_ascii=False),
                    data["status"],
                    now,
                    now,
                ),
            )
            if expected_topic_status is None:
                connection.execute(
                    "UPDATE topics SET status = 'drafting', updated_at = ? "
                    "WHERE user_id = ? AND id = ? AND status = 'approved'",
                    (now, user_id, data["topic_id"]),
                )
            self._activity(connection, user_id, "draft", draft_id, "created", actor)
        return self.get_draft(user_id, draft_id)  # type: ignore[return-value]

    def get_draft(self, user_id: str, draft_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM drafts WHERE user_id = ? AND id = ?",
                (user_id, draft_id),
            ).fetchone()
        return self._decode(row)

    def list_drafts(
        self,
        user_id: str,
        status: str | None = None,
        limit: int = 50,
        account_id: str | None = None,
    ) -> list[dict[str, Any]]:
        query = "SELECT * FROM drafts WHERE user_id = ?"
        params: list[Any] = [user_id]
        if status:
            query += " AND status = ?"
            params.append(status)
        if account_id:
            query += " AND account_id = ?"
            params.append(account_id)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        with self.connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return self._decode_many(rows)

    def update_draft(
        self,
        user_id: str,
        draft_id: str,
        changes: dict[str, Any],
        actor: str = "user",
        expected_status: str | None = None,
    ) -> dict[str, Any] | None:
        if not changes:
            return self.get_draft(user_id, draft_id)
        values = dict(changes)
        for key in ("hashtags", "image_prompts", "compliance_notes"):
            if key in values:
                values[key] = json.dumps(values[key], ensure_ascii=False)
        values["updated_at"] = utc_now()
        assignments = ", ".join(f"{key} = ?" for key in values)
        with self.connect() as connection:
            where = "WHERE user_id = ? AND id = ?"
            params: list[Any] = [*values.values(), user_id, draft_id]
            if expected_status is not None:
                where += " AND status = ?"
                params.append(expected_status)
            cursor = connection.execute(f"UPDATE drafts SET {assignments} {where}", params)
            changed = cursor.rowcount > 0
            if changed:
                self._activity(connection, user_id, "draft", draft_id, "updated", actor)
        return self.get_draft(user_id, draft_id) if changed else None

    def delete_strategy(self, user_id: str, strategy_id: str) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM strategies WHERE user_id = ? AND id = ?",
                (user_id, strategy_id),
            )
            deleted = cursor.rowcount > 0
            if deleted:
                self._activity(connection, user_id, "strategy", strategy_id, "deleted", "admin")
        return deleted

    def delete_topic(self, user_id: str, topic_id: str) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM topics WHERE user_id = ? AND id = ?",
                (user_id, topic_id),
            )
            deleted = cursor.rowcount > 0
            if deleted:
                self._activity(connection, user_id, "topic", topic_id, "deleted", "admin")
        return deleted

    def delete_draft(self, user_id: str, draft_id: str) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM drafts WHERE user_id = ? AND id = ?",
                (user_id, draft_id),
            )
            deleted = cursor.rowcount > 0
            if deleted:
                self._activity(connection, user_id, "draft", draft_id, "deleted", "admin")
        return deleted

    def dashboard(
        self,
        user_id: str,
        account_id: str | None = None,
    ) -> dict[str, Any]:
        scope = " AND account_id = ?" if account_id else ""
        args: tuple[Any, ...] = (user_id, account_id) if account_id else (user_id,)
        with self.connect() as connection:
            counts = {
                "topics": connection.execute(
                    f"SELECT COUNT(*) FROM topics WHERE user_id = ?{scope}",
                    args,
                ).fetchone()[0],
                "approved_topics": connection.execute(
                    "SELECT COUNT(*) FROM topics WHERE user_id = ? AND status = 'approved'"
                    f"{scope}",
                    args,
                ).fetchone()[0],
                "drafts": connection.execute(
                    f"SELECT COUNT(*) FROM drafts WHERE user_id = ?{scope}",
                    args,
                ).fetchone()[0],
                "ready_drafts": connection.execute(
                    "SELECT COUNT(*) FROM drafts WHERE user_id = ? "
                    f"AND status IN ('review', 'approved'){scope}",
                    args,
                ).fetchone()[0],
            }
            activity = self._decode_many(
                connection.execute(
                    "SELECT * FROM activity_log WHERE user_id = ? "
                    "ORDER BY created_at DESC LIMIT 8",
                    (user_id,),
                ).fetchall(),
            )
        strategies = self.list_strategies(user_id, 1, account_id=account_id)
        return {
            "account": (
                self.get_account_by_id(user_id, account_id) if account_id else None
            ),
            "strategy": strategies[0] if strategies else None,
            "counts": counts,
            "recent_topics": self.list_topics(user_id, limit=5, account_id=account_id),
            "recent_drafts": self.list_drafts(user_id, limit=5, account_id=account_id),
            "activity": activity,
        }
