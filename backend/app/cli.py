"""Служебные команды: python -m app.cli init | worker | reset"""
import logging
import sys
import time

from sqlalchemy import text

from . import db as dbm
from .config import get_settings
from .logging_conf import setup_logging
from .services.integrations import mocks_health

log = logging.getLogger("cli")


def wait_for_db(timeout: int = 60) -> None:
    deadline = time.time() + timeout
    while True:
        try:
            with dbm.engine.connect() as c:
                c.execute(text("select 1"))
            return
        except Exception as e:  # noqa: BLE001
            if time.time() > deadline:
                raise
            log.info("waiting for database: %s", e.__class__.__name__)
            time.sleep(2)


def wait_for_mocks(timeout: int = 60) -> None:
    deadline = time.time() + timeout
    while not mocks_health():
        if time.time() > deadline:
            raise RuntimeError("mocks service is not available")
        log.info("waiting for mocks service")
        time.sleep(2)


def init() -> None:
    """Создание схемы БД (миграции Alembic) и загрузка демо-данных."""
    from alembic import command
    from alembic.config import Config

    from .seed import seed

    wait_for_db()
    cfg = Config("alembic.ini")
    command.upgrade(cfg, "head")
    log.info("migrations applied")
    if get_settings().seed_demo_data:
        wait_for_mocks()
        seed(dbm.SessionLocal)


def worker() -> None:
    from .services.pipeline import worker_loop

    wait_for_db()
    worker_loop(dbm.SessionLocal)


def main() -> None:
    setup_logging()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "init"
    {"init": init, "worker": worker}[cmd]()


if __name__ == "__main__":
    main()
