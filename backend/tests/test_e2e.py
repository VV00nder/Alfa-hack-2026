"""Сквозные сценарии через публичный API (те же, что описаны в docs/test-scenarios.md)."""
import re

from conftest import login

API = "/api/v1"


def new_app(client, h, product, amount, term, purpose="WORKING_CAPITAL", revenue=None, expenses=None, collateral=None):
    pre = client.get(f"{API}/companies/me/prefill", headers=h).json()
    fin = pre["financials"]
    r = client.post(f"{API}/applications", headers=h,
                    json={"product_code": product, "amount": amount, "term_months": term, "purpose": purpose})
    assert r.status_code == 201, r.text
    app_id = r.json()["id"]
    form = {"financials": {"revenue_last_year": revenue or fin["revenue_last_year"],
                           "expenses_last_year": expenses or fin["expenses_last_year"], "existing_monthly_payments": 0},
            "company_confirmed": True, "owner_guarantee": product == "WORKING_CAPITAL"}
    if collateral:
        form["collateral"] = collateral
    r = client.patch(f"{API}/applications/{app_id}", headers=h,
                     json={"form_data": form, "consents": {"bki": True, "personal_data": True}})
    assert r.status_code == 200, r.text
    return app_id


def submit(client, h, app_id):
    r = client.post(f"{API}/applications/{app_id}/submit", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def test_happy_path_auto_approval_to_disbursement(client):
    h = login(client, "bakery@demo.ru")
    app_id = new_app(client, h, "EXPRESS", 3_000_000, 24, "EQUIPMENT")
    a = submit(client, h, app_id)
    assert a["status"] == "APPROVED", a["events"]
    assert a["offer"]["options"][0]["amount"] == 3_000_000
    statuses = [e["to_status"] for e in a["events"] if e["to_status"]]
    assert statuses == ["DRAFT", "SUBMITTED", "VALIDATION", "ENRICHMENT", "SCORING", "APPROVED"]
    assert "score" not in (a["scoring"] or {})  # внутренние баллы клиенту не раскрываются

    a = client.post(f"{API}/applications/{app_id}/accept-offer", headers=h, json={"option_index": 0}).json()
    assert a["status"] == "SIGNING"
    assert any(d["doc_type"] == "CONTRACT" for d in a["documents"])

    r = client.post(f"{API}/applications/{app_id}/sign", headers=h, json={"code": "000000"})
    assert r.status_code == 422
    notes = client.get(f"{API}/notifications", headers=h).json()
    code = re.search(r":\s*(\d{6})\.",next(n["body"] for n in notes if n["kind"] == "SIGN_CODE")).group(1)
    a = client.post(f"{API}/applications/{app_id}/sign", headers=h, json={"code": code}).json()
    assert a["status"] == "DISBURSED"
    assert len(a["loan"]["schedule"]) == 24 and a["loan"]["account"]


def test_counter_offer_and_accept_alternative(client):
    h = login(client, "smirnov@demo.ru")
    a = submit(client, h, new_app(client, h, "EXPRESS", 5_000_000, 24, "EQUIPMENT"))
    assert a["status"] == "COUNTER_OFFER"
    kinds = [o["kind"] for o in a["offer"]["options"]]
    assert "REDUCED_AMOUNT" in kinds and "OTHER_PRODUCT" in kinds
    idx = kinds.index("OTHER_PRODUCT")
    a = client.post(f"{API}/applications/{a['id']}/accept-offer", headers=h, json={"option_index": idx}).json()
    assert a["status"] == "SIGNING"


def test_info_request_then_manual_review_and_analyst_decision(client):
    h = login(client, "stroy@demo.ru")
    app_id = new_app(client, h, "WORKING_CAPITAL", 15_000_000, 18)
    a = submit(client, h, app_id)
    assert a["status"] == "INFO_REQUESTED"
    assert any(i.get("doc_type") == "FIN_STATEMENTS" for i in a["info_request"]["items"])

    r = client.post(f"{API}/applications/{app_id}/info-response", headers=h, json={})
    assert r.status_code == 422  # документ не загружен
    files = {"file": ("balance.pdf", b"%PDF-1.4 synthetic", "application/pdf")}
    assert client.post(f"{API}/applications/{app_id}/documents", headers=h, data={"doc_type": "FIN_STATEMENTS"}, files=files).status_code == 201
    a = client.post(f"{API}/applications/{app_id}/info-response", headers=h, json={"comment": "Отчётность загружена"}).json()
    assert a["status"] == "MANUAL_REVIEW"

    ha = login(client, "analyst@bank.ru", "Analyst123!")
    card = client.get(f"{API}/bank/applications/{app_id}", headers=ha).json()
    assert card["scoring"]["grade"] in ("C", "D")
    assert any(m["code"] == "MT01" for m in card["scoring"]["manual_triggers"])
    assert client.get(f"{API}/bank/applications/{app_id}/ai-summary", headers=ha).json()["summary"]
    wi = client.post(f"{API}/bank/applications/{app_id}/what-if?amount=2000000&term_months=24", headers=ha).json()
    assert wi["affordability"]["max_amount_for_term"] > 0
    client.post(f"{API}/bank/applications/{app_id}/assign", headers=ha)
    r = client.post(f"{API}/bank/applications/{app_id}/decision", headers=ha,
                    json={"action": "COUNTER_OFFER", "amount": 2_500_000, "term_months": 18, "comment": "Снижение лимита до уровня денежного потока"})
    assert r.status_code == 200, r.text
    a = client.get(f"{API}/applications/{app_id}", headers=h).json()
    assert a["status"] == "COUNTER_OFFER" and a["offer"]["options"][0]["amount"] == 2_500_000


def test_rejection_with_explanation(client):
    h = login(client, "romashka@demo.ru")
    a = submit(client, h, new_app(client, h, "EXPRESS", 2_000_000, 12))
    assert a["status"] == "REJECTED"
    assert any("налог" in r.lower() for r in a["decision"]["reasons"])
    assert a["decision"]["tips"]


def test_revenue_mismatch_requests_statement(client):
    h = login(client, "bakery@demo.ru")
    app_id = new_app(client, h, "EXPRESS", 1_000_000, 12, revenue=120_000_000, expenses=90_000_000)
    a = submit(client, h, app_id)
    assert a["status"] == "INFO_REQUESTED"
    assert a["info_request"]["items"][0]["code"] == "REVENUE_MISMATCH"
    csv = "\n".join(f"2026-{m:02d}-10;4000000;Оплата" for m in range(1, 7)).encode()
    up = client.post(f"{API}/applications/{app_id}/documents", headers=h, data={"doc_type": "BANK_STATEMENT"},
                     files={"file": ("statement.csv", csv, "text/csv")}).json()
    assert up["parsed"]["ok"] and up["parsed"]["months"] == 6
    a = client.post(f"{API}/applications/{app_id}/info-response", headers=h, json={"comment": "Выписка"}).json()
    assert a["status"] == "APPROVED"


def test_source_outage_degrades_to_manual_review(client, chaos):
    h = login(client, "bakery@demo.ru")
    app_id = new_app(client, h, "EXPRESS", 1_000_000, 12)
    chaos("bki", 1.0)
    a = submit(client, h, app_id)
    assert a["status"] == "MANUAL_REVIEW"


def test_committee_four_eyes(client):
    ha = login(client, "analyst@bank.ru", "Analyst123!")
    queue = client.get(f"{API}/bank/applications?status=MANUAL_REVIEW", headers=ha).json()
    big = next(x for x in queue if x["amount"] > 15_000_000)
    r = client.post(f"{API}/bank/applications/{big['id']}/decision", headers=ha, json={"action": "APPROVE", "comment": "Залог достаточный"})
    assert r.json()["status"] == "COMMITTEE_REVIEW"
    r = client.post(f"{API}/bank/applications/{big['id']}/decision", headers=ha, json={"action": "APPROVE", "comment": "ещё раз"})
    assert r.status_code == 403
    hr = login(client, "risk@bank.ru", "Risk123!")
    r = client.post(f"{API}/bank/applications/{big['id']}/decision", headers=hr, json={"action": "APPROVE", "comment": "Согласовано"})
    assert r.json()["status"] == "APPROVED"


def test_access_control(client):
    h1, h2 = login(client, "bakery@demo.ru"), login(client, "smirnov@demo.ru")
    my = client.get(f"{API}/applications", headers=h1).json()
    assert client.get(f"{API}/applications/{my[0]['id']}", headers=h2).status_code == 404
    assert client.get(f"{API}/bank/applications", headers=h1).status_code == 403
    assert client.get(f"{API}/applications").status_code == 401
    assert client.post(f"{API}/auth/login", json={"email": "bakery@demo.ru", "password": "wrong-pass"}).status_code == 401


def test_personalized_feed_differs_by_client(client):
    f1 = client.get(f"{API}/news/feed", headers=login(client, "bakery@demo.ru")).json()
    f2 = client.get(f"{API}/news/feed", headers=login(client, "smirnov@demo.ru")).json()
    t1, t2 = {n["title"] for n in f1}, {n["title"] for n in f2}
    assert any("Пекарн" in t for t in t1) and not any("Пекарн" in t for t in t2)
    assert any("Грузоперевоз" in t for t in t2) and not any("Грузоперевоз" in t for t in t1)
    assert all(n["reasons"] for n in f1)


def test_registration_by_inn_and_assistant(client):
    r = client.post(f"{API}/auth/register", json={"email": "new@demo.ru", "password": "Secret123!", "full_name": "Новый Клиент",
                                                  "inn": "7720123457"})
    assert r.status_code == 201, r.text
    assert r.json()["user"]["company"]["okved"]
    assert client.post(f"{API}/auth/register", json={"email": "x@demo.ru", "password": "Secret123!", "full_name": "Ошибка",
                                                     "inn": "7720123450"}).status_code == 422
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    ans = client.post(f"{API}/assistant/chat", headers=h, json={"message": "Нужно 2 млн на закупку товара на год"}).json()
    assert ans["parsed"]["amount"] == 2_000_000 and ans["recommendations"]


def test_dashboard_and_health(client):
    ha = login(client, "analyst@bank.ru", "Analyst123!")
    d = client.get(f"{API}/bank/dashboard", headers=ha).json()
    assert d["decided"] > 0 and 0 <= d["auto_decision_rate"] <= 1
    assert client.get("/api/health/ready").status_code == 200
    assert "http_requests_total" in client.get("/metrics").text
