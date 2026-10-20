"""Клиенты внешних систем. В проверяемой версии все они смоделированы сервисом `mocks`.

Надёжность: таймаут, повтор с экспоненциальной паузой, а при недоступности источника —
мягкая деградация (заявка уходит на ручное рассмотрение, а не падает).
"""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from ..config import get_settings

log = logging.getLogger("integrations")


class SourceUnavailable(Exception):
    def __init__(self, source: str, reason: str):
        super().__init__(f"{source}: {reason}")
        self.source = source
        self.reason = reason


def _call(source: str, method: str, path: str, json: dict | None = None) -> dict[str, Any]:
    s = get_settings()
    last_err = ""
    for attempt in range(1, s.integration_retries + 1):
        try:
            with httpx.Client(base_url=s.mocks_url, timeout=s.integration_timeout_sec) as c:
                r = c.request(method, path, json=json, headers={"X-Client": "creditflow"})
            if r.status_code == 404:
                return {"found": False}
            if r.status_code >= 500:
                raise httpx.HTTPStatusError(f"HTTP {r.status_code}", request=r.request, response=r)
            r.raise_for_status()
            data = r.json()
            data.setdefault("found", True)
            return data
        except (httpx.HTTPError, ValueError) as e:  # сеть, таймаут, 5xx, битый JSON
            last_err = str(e) or e.__class__.__name__
            log.warning("integration call failed", extra={"source": source, "attempt": attempt, "error": last_err})
            if attempt < s.integration_retries:
                time.sleep(0.2 * 2 ** (attempt - 1))
    raise SourceUnavailable(source, last_err)


def egrul(inn: str) -> dict:
    return _call("ЕГРЮЛ/ЕГРИП", "GET", f"/egrul/v1/companies/{inn}")


def fns_transparent(inn: str) -> dict:
    return _call("ФНС «Прозрачный бизнес»", "GET", f"/fns/v1/transparent-business/{inn}")


def bki_report(inn: str, consent_id: str) -> dict:
    return _call("Бюро кредитных историй", "POST", "/bki/v1/reports", {"inn": inn, "consent_id": consent_id})


def antifraud(inn: str, amount: float, channel: str = "web") -> dict:
    return _call("Антифрод", "POST", "/antifraud/v1/check", {"inn": inn, "amount": amount, "channel": channel})


def internal_accounts(inn: str) -> dict:
    return _call("АБС банка (счета)", "GET", f"/abs/v1/accounts/{inn}")


def core_disburse(payload: dict) -> dict:
    return _call("АБС банка (выдача)", "POST", "/abs/v1/loans", payload)


def mocks_health() -> bool:
    try:
        with httpx.Client(base_url=get_settings().mocks_url, timeout=1.5) as c:
            return c.get("/health").status_code == 200
    except httpx.HTTPError:
        return False
