# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the openswarm backend sidecar (onedir).

Build from the repo root:
    uv run pyinstaller desktop/backend.spec --distpath dist-backend --workpath build/pyi -y
"""
import os

from PyInstaller.utils.hooks import collect_all

REPO_ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))

datas = [
    (os.path.join(REPO_ROOT, "skills"), "skills"),
    (os.path.join(REPO_ROOT, "web"), "web"),
    (os.path.join(REPO_ROOT, "migrations"), "migrations"),
]
binaries = []
hiddenimports = [
    # uvicorn resolves these lazily at startup.
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]

# agentscope loads skills/tools dynamically; fakeredis pulls in lua support.
for package in ("agentscope", "fakeredis", "lupa"):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(package)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

a = Analysis(
    [os.path.join(REPO_ROOT, "desktop_entry.py")],
    pathex=[REPO_ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "IPython"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="openswarm-backend",
    debug=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="openswarm-backend",
)
