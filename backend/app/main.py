import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from sqlalchemy import text
from sqlalchemy.orm.exc import StaleDataError

from . import db as dbm
from .api import applications, auth, bank, catalog, engagement
from .config import get_settings
from .logging_conf import request_id_ctx, setup_logging
from .services import assistant, integrations
from .state_machine import STATUS_INFO, TRANSITIONS

setup_logging()
log = logging.getLogger("api")
settings = get_settings()

REQS = Counter("http_requests_total", "HTTP requests", ["method", "route", "status"])
LAT = Histogram("http_request_duration_seconds", "HTTP latency", ["method", "route"])

app = FastAPI(
    title="CreditFlow — умный кредитный кабинет предпринимателя",
    version=settings.app_version,
    description=(
        "API цифрового кредитного конвейера для малого и микробизнеса: клиентский путь (подбор продукта, заявка, "
        "предложение, подписание) и внутренняя обработка (проверка, обогащение, скоринг, решение, ручное рассмотрение).\n\n"
        "Авторизация: `POST /api/v1/auth/login` → `Authorization: Bearer <token>`. Тестовые учётные записи — в README."
    ),
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def observability(request: Request, call_next):
    rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:16]
    token = request_id_ctx.set(rid)
    start = time.perf_counter()
    try:
        response = await call_next(request)
    finally:
        request_id_ctx.reset(token)
    route = request.scope.get("route")
    path = getattr(route, "path", "unmatched")
    dur = time.perf_counter() - start
    REQS.labels(request.method, path, response.status_code).inc()
    LAT.labels(request.method, path).observe(dur)
    response.headers["X-Request-ID"] = rid
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    if path != "/metrics":
        log.info("request", extra={"rid": rid, "method": request.method, "path": path, "status": response.status_code,
                                   "ms": round(dur * 1000, 1)})
    return response


@app.exception_handler(StaleDataError)
async def stale(_: Request, __: StaleDataError):
    return JSONResponse(status_code=409, content={"detail": "Заявка была изменена параллельно. Обновите страницу."})


API = "/api/v1"
for r in (auth.router, catalog.router, applications.router, engagement.router, bank.router):
    app.include_router(r, prefix=API)


@app.get("/api/health/live", tags=["Ops"], summary="Liveness-проба")
def live():
    return {"status": "ok"}


@app.get("/api/health/ready", tags=["Ops"], summary="Readiness-проба: БД и внешние сервисы")
def ready():
    checks = {}
    try:
        with dbm.engine.connect() as c:
            c.execute(text("select 1"))
        checks["database"] = "ok"
    except Exception as e:  # noqa: BLE001
        checks["database"] = f"error: {e.__class__.__name__}"
    checks["integrations"] = "ok" if integrations.mocks_health() else "degraded"
    checks["llm"] = assistant.llm_status()
    ok = checks["database"] == "ok"
    return JSONResponse(status_code=200 if ok else 503, content={"status": "ok" if ok else "fail", "checks": checks,
                                                                   "version": settings.app_version})


@app.get("/metrics", include_in_schema=False)
def metrics():
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get(f"{API}/meta/statuses", tags=["Ops"], summary="Справочник статусов и допустимых переходов")
def statuses():
    return {"statuses": STATUS_INFO, "transitions": {k: sorted(v) for k, v in TRANSITIONS.items()},
            "key_rate": settings.key_rate}
