import pytest

from app.scoring.engine import Features, ProductTerms, decide, grade_for, scorecard
from app.scoring.finance import annuity_payment, max_principal, schedule
from app.services.assistant import parse_need_rules
from app.services.documents import parse_bank_statement
from app.state_machine import TRANSITIONS, can_transition
from app.state_machine import Status as S
from app.validators import is_valid_inn

EXPRESS = ProductTerms("EXPRESS", "Экспресс-кредит", 300_000, 10_000_000, 3, 36, 6.0)


def good(**kw) -> Features:
    base = dict(business_age_months=60, revenue_annual=48e6, expenses_annual=39e6, existing_monthly_payments=85_000,
                okved="10.71", bki_score=780, is_bank_client=True, account_months=30, avg_turnover_in=4e6)
    base.update(kw)
    return Features(**base)


@pytest.mark.parametrize("inn,ok", [("7704123450", True), ("165512345632", True), ("7704123451", False),
                                    ("12345", False), ("abcdefghij", False)])
def test_inn_checksum(inn, ok):
    assert is_valid_inn(inn) is ok


def test_annuity_roundtrip():
    pay = annuity_payment(3_000_000, 19.5, 24)
    assert 150_000 < pay < 155_000
    assert abs(max_principal(pay, 19.5, 24) - 3_000_000) < 1
    rows = schedule(1_000_000, 12, 12, __import__("datetime").date(2026, 1, 1))
    assert len(rows) == 12 and rows[-1]["balance"] == 0
    assert abs(sum(r["principal"] for r in rows) - 1_000_000) < 0.05


def test_state_machine_guards():
    assert can_transition(S.DRAFT, S.SUBMITTED)
    assert not can_transition(S.DRAFT, S.APPROVED)
    assert not can_transition(S.REJECTED, S.APPROVED)
    for final in (S.REJECTED, S.DISBURSED, S.CANCELLED):
        assert TRANSITIONS[final] == set()
    reachable, stack = set(), [S.DRAFT]
    while stack:
        cur = stack.pop()
        for nxt in TRANSITIONS[cur] - reachable:
            reachable.add(nxt)
            stack.append(nxt)
    assert set(TRANSITIONS) - {S.DRAFT} <= reachable  # все статусы достижимы


def test_scorecard_is_amount_independent():
    s1, _ = scorecard(good())
    res = decide(good(), EXPRESS, 9_000_000, 12, 14.0, 10e6)
    assert res["score"] == s1  # скоринг оценивает заёмщика, а не размер запроса
    assert grade_for(s1) == "A"


def test_approve_vs_counter_offer():
    assert decide(good(), EXPRESS, 3_000_000, 24, 14.0, 10e6)["decision"]["outcome"] == "APPROVE"
    weak = good(revenue_annual=14e6, expenses_annual=11.2e6, existing_monthly_payments=60_000, is_bank_client=False,
                account_months=0, bki_score=690, max_overdue_days_12m=12, okved="49.41", business_age_months=23)
    res = decide(weak, EXPRESS, 5_000_000, 24, 14.0, 10e6)
    assert res["decision"]["outcome"] == "COUNTER_OFFER"
    alt = res["decision"]["alternatives"][0]
    assert alt["amount"] < 5_000_000 and alt["monthly_payment"] <= res["affordability"]["max_payment"] + 1


def test_stop_factors_reject():
    res = decide(good(tax_arrears=1_200_000, disqualified_director=True), EXPRESS, 1_000_000, 12, 14.0, 10e6)
    assert res["decision"]["outcome"] == "REJECT"
    assert {s["code"] for s in res["stop_factors"]} >= {"SF02", "SF06"}


def test_manual_triggers():
    res = decide(good(mass_address=True), EXPRESS, 1_000_000, 12, 14.0, 10e6)
    assert res["decision"]["outcome"] == "MANUAL_REVIEW"
    res = decide(good(sources_unavailable=["Бюро кредитных историй"]), EXPRESS, 1_000_000, 12, 14.0, 10e6)
    assert res["decision"]["outcome"] == "MANUAL_REVIEW"


def test_need_parser():
    p = parse_need_rules("Хочу купить новую печь за 3,5 млн на 2 года, есть помещение в собственности под залог")
    assert p == {"purpose": "EQUIPMENT", "amount": 3_500_000, "term_months": 24, "has_collateral": True}
    p = parse_need_rules("нужно 800 тыс на закупку товара к сезону на полгода")
    assert p["purpose"] == "WORKING_CAPITAL" and p["amount"] == 800_000 and p["term_months"] == 6


def test_statement_parser():
    csv = "date;amount;description\n2026-01-10;1 000 000;Оплата\n2026-01-15;-300000;Аренда\n2026-02-10;2000000,50;Оплата\n"
    r = parse_bank_statement(csv.encode())
    assert r["ok"] and r["months"] == 2 and r["avg_monthly_inflow"] == 1_500_000.25
    assert not parse_bank_statement(b"garbage")["ok"]
