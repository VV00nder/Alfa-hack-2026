# syntax=docker/dockerfile:1
FROM python:3.12.8-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /srv

FROM base AS deps
COPY requirements.txt .
RUN pip install --require-hashes -r requirements.txt

FROM deps AS test
COPY requirements-dev.txt .
RUN pip install --require-hashes -r requirements-dev.txt
COPY . .
COPY --from=mocks . /mocks
ENV PYTHONPATH=/srv:/mocks
CMD ["pytest", "-q"]

FROM deps AS runtime
RUN useradd --uid 10001 --create-home app
COPY --chown=app:app . .
USER app
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health/live').status==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--proxy-headers"]
