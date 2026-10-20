"""Тестовое окружение: SQLite + синхронный конвейер + сервис моков, подключённый in-process."""
import importlib.util
import os
import sys
from pathlib import Path

import pytest

DB_FILE = Path(__file__).parent / "test.db"
os.environ.update({
    "DATABASE_URL": f"sqlite:///{DB_FILE.as_posix()}",
    "RUN_PIPELINE_INLINE": "true",
    "PIPELINE_STEP_DELAY_SEC": "0",
    "INTEGRATION_RETRIES": "1",
    "MOCK_LATENCY_MS": "0",
    "SEED_DEMO_DATA": "true",
    "LLM_ENABLED": "false",
})

from fastapi.testclient import TestClient  # noqa: E402


def _load_mocks():
    candidates = [Path(__file__).resolve().parents[2] / "mocks" / "app.py", Path("/mocks/app.py")]
    path = next(p for p in candidates if p.exists())
    spec = importlib.util.spec_from_file_location("mocks_app", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mocks_app"] = mod
    spec.loader.exec_module(mod)
    return mod


mocks = _load_mocks()
mocks_client = TestClient(mocks.app)


def _call(source, method, path, json=None):
    from app.services.integrations import SourceUnavailable

    r = mocks_client.request(method, path, json=json)
    if r.status_code == 404:
        return {"found": False}
    if r.status_code >= 500:
        raise SourceUnavailable(source, f"HTTP {r.status_code}")
    r.raise_for_status()
    data = r.json()
    data.setdefault("found", True)
    return data


@pytest.fixture(scope="session")
def client():
    if DB_FILE.exists():
        DB_FILE.unlink()
    from app import db as dbm
    from app.services import integrations

    integrations._call = _call
    integrations.mocks_health = lambda: True
    from app.db import Base
    from app.seed import seed

    Base.metadata.create_all(dbm.engine)
    seed(dbm.SessionLocal)
    from app.main import app

    with TestClient(app) as c:
        yield c
    dbm.engine.dispose()
    DB_FILE.unlink(missing_ok=True)


@pytest.fixture()
def chaos():
    """Включить сбой источника на время теста."""
    def set_rate(source: str, rate: float):
        mocks.CHAOS[source] = rate
    yield set_rate
    mocks.CHAOS.clear()
    mocks.CHAOS["default"] = 0.0


def login(client, email, password="Demo123!"):
    r = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}
