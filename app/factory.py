"""Application composition root."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from agentscope.app import create_app
from agentscope.app.rag.blob_store import LocalBlobStore
from agentscope.app.rag.knowledge_base_manager import CollectionPerKbManager
from agentscope.rag import PDFParser, QdrantStore, TextParser

from app.account_benchmark.client import RedFoxAccountClient
from app.account_benchmark.router import create_account_benchmark_router
from app.account_benchmark.service import AccountBenchmarkService
from app.admin.router import create_admin_router
from app.agent_team.workspace import RoleAwareWorkspaceManager
from app.agent_team.credential_vault import CredentialVault
from app.agent_team.router import create_agent_team_router
from app.agent_team.runtime import build_agent_runtime
from app.agent_team.templates import build_subagent_templates
from app.agent_team.tools import (
    build_agent_tools_factory,
    build_role_tools_inspector,
)
from app.artifacts.router import create_artifacts_router
from app.cover_design.router import create_cover_design_router
from app.cover_design.service import CoverDesignService
from app.core.config import PROJECT_ROOT, Settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging
from app.core.middleware import register_http_middleware
from app.core.redfox_key import RedFoxKeyStore
from app.insights.client import RedFoxClient
from app.insights.router import create_insights_router
from app.insights.service import InsightService
from app.operations.repository import OperationsRepository
from app.operations.router import create_operations_router
from app.operations.service import OperationsService
from app.title_insights.client import RedFoxTitleTrendClient
from app.title_insights.router import create_title_insights_router
from app.title_insights.service import TitleInsightService


def build_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    configure_logging(settings.log_level)

    repository = OperationsRepository(
        settings.resolved_database_path,
        PROJECT_ROOT / "migrations",
    )
    service = OperationsService(repository)
    # Admin-configurable RedFox key, persisted beside the database so the
    # packaged desktop build can set it without an editable .env.
    redfox_keys = RedFoxKeyStore(
        settings.resolved_database_path.parent / "redfox_key.json",
        settings.redfox_api_key,
    )
    insight_service = InsightService(
        RedFoxClient(
            redfox_keys.get,
            settings.redfox_timeout_seconds,
        ),
        settings.resolved_reports_dir,
    )
    account_benchmark_service = AccountBenchmarkService(
        RedFoxAccountClient(
            redfox_keys.get,
            settings.redfox_timeout_seconds,
        ),
        settings.resolved_reports_dir,
    )
    title_insight_service = TitleInsightService(
        RedFoxTitleTrendClient(
            redfox_keys.get,
            settings.redfox_timeout_seconds,
        ),
        settings.resolved_reports_dir,
    )
    cover_design_service = CoverDesignService(
        RedFoxTitleTrendClient(
            redfox_keys.get,
            settings.redfox_timeout_seconds,
        ),
        settings.resolved_reports_dir,
    )
    runtime = build_agent_runtime(settings)
    settings.resolved_workspace_dir.mkdir(parents=True, exist_ok=True)
    data_dir = settings.resolved_database_path.parent

    app = create_app(
        storage=runtime.storage,
        message_bus=runtime.message_bus,
        workspace_manager=RoleAwareWorkspaceManager(
            basedir=str(settings.resolved_workspace_dir),
            storage=runtime.storage,
        ),
        knowledge_base_manager=CollectionPerKbManager(
            storage=runtime.storage,
            vector_store=QdrantStore(path=str(data_dir / "qdrant")),
        ),
        knowledge_parsers=[TextParser(), PDFParser()],
        blob_store=LocalBlobStore(root_dir=str(data_dir / "blobs")),
        extra_agent_tools=build_agent_tools_factory(
            repository,
            service,
            insight_service,
            account_benchmark_service,
            agent_storage=runtime.storage,
            title_insight_service=title_insight_service,
            cover_design_service=cover_design_service,
        ),
        custom_subagent_templates=build_subagent_templates(),
        title="openswarm Agent Team",
        version="0.1.0",
    )

    agentscope_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        try:
            repository.migrate()
            async with agentscope_lifespan(application):
                await runtime.restore_credentials()
                yield
        finally:
            await runtime.close()

    app.router.lifespan_context = lifespan
    app.state.settings = settings
    app.state.operations_repository = repository
    app.state.operations_service = service
    app.state.insight_service = insight_service
    app.state.account_benchmark_service = account_benchmark_service
    app.state.title_insight_service = title_insight_service
    app.state.cover_design_service = cover_design_service
    app.state.agent_runtime = runtime

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-User-ID", "X-Request-Id"],
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    register_http_middleware(app)
    register_error_handlers(app)
    app.include_router(
        create_operations_router(
            repository,
            service,
            CredentialVault(settings.resolved_credential_vault_path),
        ),
    )
    app.include_router(create_insights_router(insight_service))
    app.include_router(create_title_insights_router(title_insight_service))
    app.include_router(create_cover_design_router(cover_design_service))
    app.include_router(
        create_account_benchmark_router(account_benchmark_service),
    )
    app.include_router(create_agent_team_router(settings.redis_mode, runtime))
    app.include_router(create_artifacts_router(settings.resolved_reports_dir))
    app.include_router(
        create_admin_router(
            settings,
            repository,
            runtime,
            build_role_tools_inspector(
                repository,
                service,
                insight_service,
                account_benchmark_service,
                title_insight_service=title_insight_service,
                cover_design_service=cover_design_service,
            ),
            redfox_keys=redfox_keys,
        ),
    )

    @app.get("/health", tags=["system"])
    async def health() -> dict:
        return {"status": "ok", "version": "0.1.0"}

    @app.get("/ready", tags=["system"])
    async def ready():
        try:
            available = await runtime.ping()
        except Exception:
            available = False
        body = {
            "status": "ready" if available else "unavailable",
            "redis_mode": settings.redis_mode,
        }
        return body if available else JSONResponse(status_code=503, content=body)

    web_dir = PROJECT_ROOT / "web"
    if web_dir.exists():
        app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")
    return app
