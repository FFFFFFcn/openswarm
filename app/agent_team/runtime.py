"""AgentScope storage/message-bus construction for local and server modes."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import fakeredis
from fakeredis.aioredis import FakeRedis
from redis.asyncio import Redis

from agentscope.app.message_bus import RedisMessageBus
from agentscope.app.storage import RedisStorage

from app.agent_team.credential_vault import PersistentCredentialStorage
from app.core.config import Settings


@dataclass(slots=True)
class AgentRuntime:
    storage: RedisStorage
    message_bus: RedisMessageBus
    health_client: Any
    owned_clients: list[Any] = field(default_factory=list)

    async def ping(self) -> bool:
        return bool(await self.health_client.ping())

    async def restore_credentials(self) -> int:
        """Replay persisted credentials after a restart (embedded mode).

        Returns:
            The number of credentials restored (0 for external Redis).
        """
        if isinstance(self.storage, PersistentCredentialStorage):
            return await self.storage.restore_credentials()
        return 0

    async def close(self) -> None:
        for client in self.owned_clients:
            await client.aclose()


def build_agent_runtime(settings: Settings) -> AgentRuntime:
    if settings.redis_mode == "embedded":
        server = fakeredis.FakeServer(version=(7,))
        storage_client = FakeRedis(server=server, decode_responses=True)
        bus_client = FakeRedis(server=server, decode_responses=True)
        health_client = FakeRedis(server=server, decode_responses=True)
        return AgentRuntime(
            storage=PersistentCredentialStorage(
                vault_path=settings.resolved_credential_vault_path,
                connection_pool=storage_client.connection_pool,
            ),
            message_bus=RedisMessageBus(connection_pool=bus_client.connection_pool),
            health_client=health_client,
            owned_clients=[storage_client, bus_client, health_client],
        )

    options = {
        "host": settings.redis_host,
        "port": settings.redis_port,
        "db": settings.redis_db,
        "username": settings.redis_username,
        "password": settings.redis_password,
        "ssl": settings.redis_ssl,
        # RESP2 keeps compatibility with Redis 5.x servers (the bundled
        # Windows sidecar); RESP3's HELLO handshake needs Redis 6+.
        "protocol": 2,
    }
    # Build real clients first: Redis() translates the ssl flag into the
    # proper connection class, while RedisStorage/RedisMessageBus forward
    # kwargs straight into the connection pool (which rejects "ssl").
    storage_client = Redis(**options, decode_responses=True)
    bus_client = Redis(**options, decode_responses=True)
    health_client = Redis(**options, decode_responses=True)
    return AgentRuntime(
        storage=RedisStorage(connection_pool=storage_client.connection_pool),
        message_bus=RedisMessageBus(connection_pool=bus_client.connection_pool),
        health_client=health_client,
        owned_clients=[storage_client, bus_client, health_client],
    )
