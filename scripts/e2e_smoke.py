#!/usr/bin/env python3
"""Сквозная проверка запущенного стенда (только стандартная библиотека Python 3.9+).

    python scripts/e2e_smoke.py                       # по умолчанию http://localhost:8080
    python scripts/e2e_smoke.py --base http://host:8080

Проходит 4 клиентских сценария (автоодобрение → выдача, встречное предложение, запрос
информации → ручное рассмотрение → решение аналитика, отказ) и проверяет ленту и метрики.
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request

BASE = "http://localhost:8080"
OK, FAIL = "\033[32m✓\033[0m", "\033[31m✗\033[0m"
failures = 0


def call(method, path, token=None, body=None, form=None):
    headers = {}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if form is not None:
        boundary = "----cfsmoke"
        parts = []
        for k, v in form.items():
            if isinstance(v, tuple):
                name, content, ctype = v
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\nContent-Type: {ctype}\r\n\r\n'.encode() + content + b"\r\n")
            else:
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        data = b"".join(parts) + f"--{boundary}--\r\n".encode()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    req = urllib.request.Request(BASE + "/api/v1" + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, (json.loads(raw) if raw else None)


def check(cond, msg):
    global failures
    print(f"  {OK if cond else FAIL} {msg}")
    if not cond:
        failures += 1
    return cond


def login(email, pw="Demo123!"):
    st, r = call("POST", "/auth/login", body={"email": email, "password": pw})
    assert st == 200, f"login {email}: {st} {r}"
    return r["access_token"]


def wait_status(token, app_id, stop, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        _, a = call("GET", f"/applications/{app_id}", token)
        if a["status"] in stop:
            return a
        time.sleep(1)
    return a


def new_app(token, product, amount, term, purpose="WORKING_CAPITAL", collateral=None):
    _, pre = call("GET", "/companies/me/prefill", token)
    st, a = call("POST", "/applications", token, {"product_code": product, "amount": amount, "term_months": term, "purpose": purpose})
    assert st == 201, a
    fin = pre["financials"]
    form = {"financials": {"revenue_last_year": fin["revenue_last_year"], "expenses_last_year": fin["expenses_last_year"],
                           "existing_monthly_payments": 0}, "company_confirmed": True, "owner_guarantee": product == "WORKING_CAPITAL"}
    if collateral:
        form["collateral"] = collateral
    call("PATCH", f"/applications/{a['id']}", token, {"form_data": form, "consents": {"bki": True, "personal_data": True}})
    st, a = call("POST", f"/applications/{a['id']}/submit", token)
    assert st == 200, a
    return a["id"]


def main():
    global BASE
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=BASE)
    BASE = ap.parse_args().base.rstrip("/")

    print("0. Готовность стенда")
    req = urllib.request.urlopen(BASE + "/api/health/ready", timeout=10)
    check(json.loads(req.read())["status"] == "ok", "health/ready = ok")

    print("1. Хлебный Дом: экспресс-кредит 3 млн → автоодобрение → подписание → выдача")
    t = login("bakery@demo.ru")
    app_id = new_app(t, "EXPRESS", 3_000_000, 24, "EQUIPMENT")
    a = wait_status(t, app_id, {"APPROVED", "COUNTER_OFFER", "REJECTED", "MANUAL_REVIEW", "INFO_REQUESTED"})
    check(a["status"] == "APPROVED", f"решение: {a['status']} (ожидалось APPROVED)")
    call("POST", f"/applications/{app_id}/accept-offer", t, {"option_index": 0})
    a = wait_status(t, app_id, {"SIGNING"})
    check(a["status"] == "SIGNING", "договор сформирован, ожидает подписи")
    _, notes = call("GET", "/notifications", t)
    code = re.search(r":\s*(\d{6})\.", next(n["body"] for n in notes if n["kind"] == "SIGN_CODE" and n["application_id"] == app_id)).group(1)
    call("POST", f"/applications/{app_id}/sign", t, {"code": code})
    a = wait_status(t, app_id, {"DISBURSED"})
    check(a["status"] == "DISBURSED" and len(a["loan"].get("schedule", [])) == 24, "деньги выданы, график из 24 платежей")

    print("2. ИП Смирнов: 5 млн при недостаточном денежном потоке → встречное предложение")
    t = login("smirnov@demo.ru")
    app_id = new_app(t, "EXPRESS", 5_000_000, 24, "EQUIPMENT")
    a = wait_status(t, app_id, {"APPROVED", "COUNTER_OFFER", "REJECTED", "MANUAL_REVIEW", "INFO_REQUESTED"})
    check(a["status"] == "COUNTER_OFFER", f"решение: {a['status']} (ожидалось COUNTER_OFFER)")
    check(len(a["offer"].get("options", [])) >= 2, f"вариантов предложения: {len(a['offer'].get('options', []))}")

    print("3. СтройМонтаж: 15 млн → запрос отчётности → ручное рассмотрение → решение аналитика")
    t = login("stroy@demo.ru")
    app_id = new_app(t, "WORKING_CAPITAL", 15_000_000, 18)
    a = wait_status(t, app_id, {"INFO_REQUESTED", "MANUAL_REVIEW", "REJECTED", "APPROVED"})
    check(a["status"] == "INFO_REQUESTED", f"банк запросил информацию: {a['status']}")
    call("POST", f"/applications/{app_id}/documents", t, form={"doc_type": "FIN_STATEMENTS", "file": ("balance.pdf", b"%PDF-1.4 synthetic", "application/pdf")})
    call("POST", f"/applications/{app_id}/info-response", t, {"comment": "Отчётность загружена"})
    a = wait_status(t, app_id, {"MANUAL_REVIEW", "REJECTED", "APPROVED"})
    check(a["status"] == "MANUAL_REVIEW", f"заявка у специалиста: {a['status']}")
    ta = login("analyst@bank.ru", "Analyst123!")
    st, r = call("POST", f"/bank/applications/{app_id}/decision", ta,
                 {"action": "COUNTER_OFFER", "amount": 2_500_000, "term_months": 18, "comment": "Лимит по денежному потоку"})
    check(st == 200 and r["status"] == "COUNTER_OFFER", "аналитик сделал встречное предложение 2,5 млн")

    print("4. Ромашка Трейд: стоп-факторы → отказ с объяснением")
    t = login("romashka@demo.ru")
    app_id = new_app(t, "EXPRESS", 2_000_000, 12)
    a = wait_status(t, app_id, {"APPROVED", "COUNTER_OFFER", "REJECTED", "MANUAL_REVIEW", "INFO_REQUESTED"})
    check(a["status"] == "REJECTED", f"решение: {a['status']} (ожидалось REJECTED)")
    check(bool(a["decision"].get("reasons")), "причины: " + "; ".join(a["decision"].get("reasons", [])))

    print("5. Персональная лента и метрики")
    _, f1 = call("GET", "/news/feed", login("bakery@demo.ru"))
    _, f2 = call("GET", "/news/feed", login("smirnov@demo.ru"))
    check(f1[0]["title"] != f2[0]["title"], f"разные ленты: «{f1[0]['title']}» vs «{f2[0]['title']}»")
    _, dsh = call("GET", "/bank/dashboard", ta)
    check(dsh["decided"] > 0, f"решений: {dsh['decided']}, автоматических {dsh['auto_decision_rate'] * 100:.0f}%")

    print(f"\n{'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' if not failures else f'ОШИБОК: {failures}'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
