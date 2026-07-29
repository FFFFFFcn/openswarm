from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.artifacts.router import create_artifacts_router


def _build_client(reports_dir: Path) -> TestClient:
    app = FastAPI()
    app.include_router(create_artifacts_router(reports_dir))
    return TestClient(app)


def test_artifacts_list_and_serve(tmp_path: Path) -> None:
    reports = tmp_path / "reports"
    reports.mkdir()
    first = reports / "11111111-1111-1111-1111-111111111111.html"
    first.write_text(
        "<!doctype html><html><head><title>AI 效率工具 · 小红书爆款洞察</title>"
        "</head><body>older</body></html>",
        encoding="utf-8",
    )
    second = reports / "22222222-2222-2222-2222-222222222222.html"
    second.write_text(
        "<!doctype html><html><head><title>账号对标报告</title></head>"
        "<body>newer</body></html>",
        encoding="utf-8",
    )
    # Ensure a deterministic mtime ordering (second is newer).
    import os

    os.utime(first, (1_000_000, 1_000_000))
    os.utime(second, (2_000_000, 2_000_000))
    # A non-HTML file must be ignored.
    (reports / "notes.txt").write_text("ignore me", encoding="utf-8")

    client = _build_client(reports)

    listing = client.get("/api/v1/artifacts").json()["data"]
    assert [item["id"] for item in listing] == [
        "22222222-2222-2222-2222-222222222222",
        "11111111-1111-1111-1111-111111111111",
    ]
    assert listing[0]["name"] == "账号对标报告"
    assert listing[1]["name"] == "AI 效率工具 · 小红书爆款洞察"
    assert listing[0]["size"] > 0
    assert listing[0]["updated_at"]

    served = client.get(
        "/api/v1/artifacts/11111111-1111-1111-1111-111111111111",
    )
    assert served.status_code == 200
    assert served.headers["content-type"].startswith("text/html")
    assert "Content-Security-Policy" in served.headers
    assert served.headers["X-Content-Type-Options"] == "nosniff"
    assert "older" in served.text


def test_artifacts_rejects_traversal_and_missing(tmp_path: Path) -> None:
    reports = tmp_path / "reports"
    reports.mkdir()
    secret = tmp_path / "secret.html"
    secret.write_text("<html>secret</html>", encoding="utf-8")

    client = _build_client(reports)

    assert client.get("/api/v1/artifacts/..%2Fsecret").status_code in {400, 404}
    assert client.get("/api/v1/artifacts/does-not-exist").status_code == 404
    assert client.get("/api/v1/artifacts").json()["data"] == []


def test_artifacts_empty_when_dir_missing(tmp_path: Path) -> None:
    client = _build_client(tmp_path / "missing")
    assert client.get("/api/v1/artifacts").json()["data"] == []


def test_artifacts_batch_delete(tmp_path: Path) -> None:
    reports = tmp_path / "reports"
    reports.mkdir()
    keep = reports / "keep-me.html"
    keep.write_text("<html><title>keep</title></html>", encoding="utf-8")
    gone = reports / "gone.html"
    gone.write_text("<html><title>gone</title></html>", encoding="utf-8")
    gone_data = reports / "gone.json"
    gone_data.write_text("{}", encoding="utf-8")

    client = _build_client(reports)

    # Missing ids are skipped; traversal ids are rejected outright.
    response = client.post(
        "/api/v1/artifacts/batch-delete",
        json={"ids": ["gone", "already-deleted"]},
    )
    assert response.status_code == 200
    assert response.json()["data"]["deleted"] == ["gone"]
    assert not gone.exists()
    assert not gone_data.exists()
    assert keep.exists()

    assert (
        client.post(
            "/api/v1/artifacts/batch-delete",
            json={"ids": ["..secret"]},
        ).status_code
        == 400
    )
    assert (
        client.post("/api/v1/artifacts/batch-delete", json={"ids": []}).status_code
        == 422
    )
