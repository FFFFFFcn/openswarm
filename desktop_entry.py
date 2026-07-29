"""Frozen desktop entrypoint used by the PyInstaller bundle.

The Electron shell spawns this executable with OPENSWARM_* environment
variables pointing at the per-user data directory and the Redis sidecar.
Stdout/stderr are piped to log files by the Electron main process, so the
entrypoint itself stays minimal: no reload, single process.
"""
from __future__ import annotations

import multiprocessing


def main() -> None:
    import uvicorn

    from app.core.config import get_settings
    from app.factory import build_app

    settings = get_settings()
    uvicorn.run(
        build_app(),
        host=settings.app_host,
        port=settings.app_port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    # Required on Windows for any transitive multiprocessing usage in a
    # frozen executable; harmless otherwise.
    multiprocessing.freeze_support()
    main()
