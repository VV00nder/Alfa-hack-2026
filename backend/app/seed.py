"""Синтетические демо-данные: продукты, компании, пользователи, новости и история заявок.

История заявок формируется не подстановкой статусов, а прогоном через реальный конвейер,
поэтому все данные (скоринг, события, предложения) согласованы.
"""
import logging
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select

from .config import get_settings
from .models import Application, Company, Document, NewsItem, Product, User
from .scoring.engine import PRIORITY_OKVED
from .security import hash_password
from .services import integrations
from .services.applications import new_number
from .services.pipeline import drain
from .state_machine import Actor, log_event, transition
from .state_machine import Status as S

log = logging.getLogger("seed")

PRODUCTS = [
    dict(code="EXPRESS", name="Экспресс-кредит", tagline="До 10 млн ₽ без залога, решение онлайн за минуты",
         description="Беззалоговый кредит на любые цели бизнеса. Данные о компании банк получает сам из ЕГРЮЛ и ФНС — "
                     "документы не нужны. Решение принимается автоматически.",
         min_amount=300_000, max_amount=10_000_000, min_term=3, max_term=36, margin=6.0,
         purposes=["WORKING_CAPITAL", "CASH_GAP", "EQUIPMENT", "EXPANSION", "TENDER"], required_documents=[],
         decision_time="≈ 5 минут", sort_order=1),
    dict(code="GOV_1764", name="Льготный кредит МСП", tagline="Ставка ниже рыночной для приоритетных отраслей",
         description="Кредит по программе государственной поддержки субъектов МСП (упрощённая модель): ставка — ключевая "
                     "ставка ЦБ + 2,75 п.п. Доступен для производства, сельского хозяйства, IT, логистики, туризма, образования "
                     "и здравоохранения.",
         min_amount=500_000, max_amount=30_000_000, min_term=6, max_term=36, margin=2.75, rate_cap=None,
         purposes=["EQUIPMENT", "WORKING_CAPITAL", "EXPANSION"], eligible_okved_prefixes=list(PRIORITY_OKVED),
         required_documents=[], decision_time="≈ 5 минут", sort_order=2),
    dict(code="WORKING_CAPITAL", name="Оборотный кредит", tagline="До 50 млн ₽ на закупки, сезонность и госконтракты",
         description="Кредит на пополнение оборотных средств под поручительство собственника бизнеса. "
                     "Для сумм больше 10 млн ₽ нужна бухгалтерская отчётность.",
         min_amount=1_000_000, max_amount=50_000_000, min_term=3, max_term=24, margin=5.0, guarantee_required=True,
         purposes=["WORKING_CAPITAL", "TENDER", "CASH_GAP", "REFINANCE"], required_documents=[],
         decision_time="от 1 часа", sort_order=3),
    dict(code="INVEST", name="Инвестиционный кредит", tagline="До 150 млн ₽ на оборудование и недвижимость под залог",
         description="Долгосрочное финансирование покупки оборудования, транспорта или недвижимости. Приобретаемое "
                     "имущество может стать залогом.",
         min_amount=3_000_000, max_amount=150_000_000, min_term=12, max_term=84, margin=4.0, collateral_required=True,
         purposes=["EQUIPMENT", "REAL_ESTATE", "EXPANSION"], required_documents=["COLLATERAL_DOCS"],
         decision_time="1–2 рабочих дня", sort_order=4),
    dict(code="OVERDRAFT", name="Овердрафт", tagline="Покрытие кассовых разрывов в пределах оборотов по счёту",
         description="Лимит до 40% среднемесячных поступлений на расчётный счёт в банке. В прототипе моделируется как "
                     "краткосрочный кредит с аннуитетным погашением.",
         min_amount=100_000, max_amount=20_000_000, min_term=1, max_term=12, margin=7.0, requires_account=True,
         purposes=["CASH_GAP"], required_documents=[], decision_time="≈ 5 минут", sort_order=5),
]

DEMO_CLIENTS = [
    ("bakery@demo.ru", "Мария Иванова", "Генеральный директор", "7704123450"),
    ("smirnov@demo.ru", "Алексей Смирнов", "Индивидуальный предприниматель", "165512345632"),
    ("stroy@demo.ru", "Игорь Кузнецов", "Генеральный директор", "5406123450"),
    ("romashka@demo.ru", "Павел Сидоров", "Генеральный директор", "7810123451"),
]
EMPLOYEES = [
    ("analyst@bank.ru", "Analyst123!", "Ксения Андеррайтерова", "Кредитный аналитик МСБ", "ANALYST"),
    ("risk@bank.ru", "Risk123!", "Роман Рисков", "Риск-менеджер", "RISK_MANAGER"),
    ("admin@bank.ru", "Admin123!", "Анна Админова", "Администратор продукта", "ADMIN"),
]
# История для очереди аналитика и дашборда: (ИНН, продукт, сумма, срок, цель, залог, документы, что сделать клиенту)
HISTORY = [
    ("6671123450", "EXPRESS", 2_000_000, 18, "EQUIPMENT", 0, [], "DISBURSE"),
    ("7715123451", "WORKING_CAPITAL", 12_000_000, 12, "WORKING_CAPITAL", 0, ["FIN_STATEMENTS"], None),
    ("165612345629", "EXPRESS", 3_000_000, 24, "EXPANSION", 0, [], None),
    ("2310123454", "GOV_1764", 8_000_000, 36, "EQUIPMENT", 0, [], "ACCEPT"),
    ("7814123452", "EXPRESS", 4_000_000, 24, "WORKING_CAPITAL", 0, [], None),
    ("5408123456", "INVEST", 25_000_000, 60, "EQUIPMENT", 40_000_000, ["COLLATERAL_DOCS", "FIN_STATEMENTS"], None),
]

D = lambda days: datetime.now(UTC) - timedelta(days=days)  # noqa: E731
NEWS = [
    dict(title="Банк России сохранил ключевую ставку на уровне 14%", category="MARKET", priority=25, published_at=D(2),
         summary="Совет директоров ЦБ на заседании 11 сентября оставил ставку без изменений. Следующее решение — 23 октября.",
         body="Ключевая ставка влияет на стоимость новых кредитов с плавающей и рыночной ставкой. Ставки по уже выданным "
              "кредитам с фиксированной ставкой не меняются.", source="Банк России (по открытым данным)", tags={}),
    dict(title="Как банк считает лимит кредита: DSCR простыми словами", category="EDUCATION", priority=15, published_at=D(6),
         summary="Почему банк может предложить меньшую сумму, чем вы просили, и как увеличить доступный лимит.",
         body="Банк сравнивает ежемесячный денежный поток бизнеса с платежами по всем кредитам. Если платежи превышают "
              "поток, делённый на 1,3, сумма уменьшается или срок увеличивается.", tags={"products": ["EXPRESS", "WORKING_CAPITAL"]},
         cta_label="Рассчитать платёж", cta_link="/products"),
    dict(title="Льготные кредиты для производителей: ставка ниже рыночной", category="SUPPORT", priority=30, published_at=D(3),
         summary="Компании обрабатывающих отраслей могут получить кредит по программе поддержки МСП со ставкой «ключевая + 2,75 п.п.».",
         body="Программа поддержки МСП позволяет производственным компаниям получить финансирование на оборудование и "
              "оборотные средства по сниженной ставке.", tags={"okved": [str(i) for i in range(10, 34)]},
         cta_label="Подобрать кредит", cta_link="/products?product=GOV_1764"),
    dict(title="Агробизнесу: сезонное финансирование посевной и уборочной", category="SUPPORT", priority=30, published_at=D(5),
         summary="Сельхозпроизводители входят в приоритетные отрасли льготной программы — до 30 млн ₽ на 3 года.",
         body="Планируйте финансирование сезонных работ заранее: решение по льготному кредиту принимается за минуты.",
         tags={"okved": ["01", "02", "03"]}, cta_label="Льготный кредит", cta_link="/products?product=GOV_1764"),
    dict(title="Пекарням и кондитерским: как пережить рост цен на муку", category="INDUSTRY", priority=20, published_at=D(1),
         summary="Закупка сырья впрок под оборотный кредит может оказаться выгоднее, чем рост цен в сезон.",
         body="Демо-материал: сравните стоимость кредита с ожидаемым ростом цен на сырьё и зафиксируйте закупку.",
         tags={"okved": ["10.7", "10.8", "56"]}),
    dict(title="Грузоперевозчикам: как планировать оборотные средства в межсезонье", category="INDUSTRY", priority=20, published_at=D(2),
         summary="Топливо, ремонт и лизинговые платежи — как не допустить кассового разрыва зимой.",
         body="Демо-материал: оцените сезонность выручки по выписке и заранее согласуйте лимит.",
         tags={"okved": ["49", "52"]}),
    dict(title="Строительным компаниям: что банк проверяет при крупном кредите", category="INDUSTRY", priority=20, published_at=D(4),
         summary="Отчётность, загрузка по контрактам, просрочки и залог: как подготовиться к экспертизе.",
         body="Демо-материал: подготовьте бухгалтерскую отчётность и перечень действующих контрактов заранее.",
         tags={"okved": ["41", "42", "43"]}),
    dict(title="Розничной торговле: управление запасами перед новогодним сезоном", category="INDUSTRY", priority=18, published_at=D(3),
         summary="Как рассчитать потребность в оборотных средствах на закупку к пиковому сезону.",
         body="Демо-материал: используйте данные продаж прошлого года, чтобы определить объём закупки.", tags={"okved": ["47"]}),
    dict(title="ИП: календарь налоговых платежей на IV квартал", category="TAX", priority=18, published_at=D(7),
         summary="Сроки уплаты авансовых платежей по УСН и страховых взносов за себя.",
         body="Демо-материал: проверьте сроки в личном кабинете налогоплательщика.", tags={"legal_forms": ["IP"]}),
    dict(title="ООО: отчётность за 9 месяцев — сроки и частые ошибки", category="TAX", priority=15, published_at=D(8),
         summary="Что и когда сдать по итогам 9 месяцев, чтобы не получить блокировку счёта.",
         body="Демо-материал.", tags={"legal_forms": ["OOO"]}),
    dict(title="Заявка у специалиста: как ускорить рассмотрение", category="EDUCATION", priority=20, published_at=D(1),
         summary="Чаще всего решение ускоряет выписка по счёту и быстрый ответ на запрос банка.",
         body="Если банк запросил информацию, ответ прямо в заявке возвращает её в работу автоматически.",
         tags={"statuses": ["MANUAL_REVIEW", "COMMITTEE_REVIEW", "INFO_REQUESTED"]}),
    dict(title="Кредит одобрен: что проверить в договоре перед подписанием", category="EDUCATION", priority=20, published_at=D(1),
         summary="Ставка, полная стоимость, график, досрочное погашение и обеспечение — короткий чек-лист.",
         body="Подписывайте договор только кодом из уведомлений личного кабинета. Сотрудники банка код не спрашивают.",
         tags={"statuses": ["APPROVED", "COUNTER_OFFER", "OFFER_ACCEPTED", "SIGNING"]}),
    dict(title="Получили кредит? Подключите торговый эквайринг со скидкой", category="PRODUCT", priority=15, published_at=D(2),
         summary="Персональное предложение для заёмщиков: льготная комиссия первые 3 месяца.",
         body="Демо-материал: пример next-best-offer после выдачи кредита.", tags={"statuses": ["DISBURSED"]},
         cta_label="Подробнее", cta_link="/"),
    dict(title="Отказали в кредите? 5 шагов к улучшению кредитного профиля", category="EDUCATION", priority=20, published_at=D(2),
         summary="Налоговая дисциплина, отсутствие просрочек, подтверждённые обороты — что влияет на решение сильнее всего.",
         body="В карточке заявки показаны факторы, которые повлияли на решение, и рекомендации.", tags={"statuses": ["REJECTED"]}),
    dict(title="Москва: субсидия на модернизацию оборудования для МСП", category="SUPPORT", priority=20, published_at=D(6),
         summary="Демо-материал: региональная мера поддержки компенсирует часть затрат на оборудование.",
         body="Демо-материал.", tags={"regions": ["г. Москва"]}),
    dict(title="Татарстан: региональный фонд поручительств для МСП", category="SUPPORT", priority=20, published_at=D(5),
         summary="Демо-материал: поручительство фонда может заменить часть залога.", body="Демо-материал.",
         tags={"regions": ["Республика Татарстан"]}),
    dict(title="Новосибирская область: гарантийный фонд снижает требования к залогу", category="SUPPORT", priority=20,
         published_at=D(4), summary="Демо-материал: поручительство до 50% суммы кредита.", body="Демо-материал.",
         tags={"regions": ["Новосибирская область"]}),
    dict(title="Микробизнесу: бизнес-карта с кешбэком на топливо", category="PRODUCT", priority=12, published_at=D(9),
         summary="Демо-материал: предложение для небольших транспортных компаний.", body="Демо-материал.",
         tags={"segments": ["micro"], "okved": ["49"]}),
]


def _company_from_egrul(inn: str) -> Company:
    eg = integrations.egrul(inn)
    return Company(inn=inn, ogrn=eg.get("ogrn"), name=eg["short_name"], legal_form=eg["legal_form"],
                   okved=eg["okved_main"]["code"], okved_name=eg["okved_main"]["name"], region=eg.get("region"),
                   address=eg.get("address"), director_name=(eg.get("director") or {}).get("name"),
                   registration_date=date.fromisoformat(eg["registration_date"]), segment=eg.get("msp_category", "micro"),
                   employees=eg.get("employees"))


def seed(session_factory) -> None:
    with session_factory() as db:
        if db.scalar(select(Product).limit(1)):
            log.info("seed skipped: data exists")
            return
        for p in PRODUCTS:
            db.add(Product(**p))
        for item in NEWS:
            db.add(NewsItem(source=item.pop("source", "Демо-контент CreditFlow"), **item))
        for email, pw, name, pos, role in EMPLOYEES:
            db.add(User(email=email, password_hash=hash_password(pw), full_name=name, position=pos, role=role))
        pw_hash = hash_password("Demo123!")
        for email, name, pos, inn in DEMO_CLIENTS:
            c = _company_from_egrul(inn)
            db.add(c)
            db.flush()
            db.add(User(email=email, password_hash=pw_hash, full_name=name, position=pos, role="CLIENT", company_id=c.id))
        db.commit()
        log.info("seed: reference data created")

    _seed_history(session_factory)


def _seed_history(session_factory) -> None:
    pw_hash = hash_password("Demo123!")
    for i, (inn, product, amount, term, purpose, collateral, docs, then) in enumerate(HISTORY):
        with session_factory() as db:
            c = _company_from_egrul(inn)
            db.add(c)
            db.flush()
            u = User(email=f"client{i + 1}@demo.ru", password_hash=pw_hash, full_name=c.director_name or c.name,
                     position="Руководитель", role="CLIENT", company_id=c.id)
            db.add(u)
            db.flush()
            fns = integrations.fns_transparent(inn)
            form = {"financials": {"revenue_last_year": fns["revenue_last_year"], "expenses_last_year": fns["expenses_last_year"],
                                   "existing_monthly_payments": 0, "employees": fns.get("avg_employees")},
                    "collateral": {"type": "EQUIPMENT" if collateral else "NONE", "estimated_value": collateral,
                                   "description": "Производственная линия (приобретаемое оборудование)" if collateral else None},
                    "contact": {"name": u.full_name}, "owner_guarantee": product == "WORKING_CAPITAL", "company_confirmed": True}
            app = Application(number=new_number(), company_id=c.id, created_by=u.id, product_code=product, amount=amount,
                              term_months=term, purpose=purpose, status=S.DRAFT, form_data=form,
                              consents={"bki": True, "personal_data": True, "given_at": date.today().isoformat()})
            db.add(app)
            db.flush()
            for dt in docs:
                content = f"Синтетический документ {dt} для {c.name}".encode()
                db.add(Document(application_id=app.id, doc_type=dt, filename=f"{dt.lower()}.pdf", content_type="application/pdf",
                                size=len(content), sha256="0" * 64, content=content, parsed={}, uploaded_by=u.id))
            actor = Actor("CLIENT", u.id, u.full_name)
            log_event(db, app, "CREATED", "Создан черновик заявки", actor, to_status=S.DRAFT)
            transition(db, app, S.SUBMITTED, actor, "Заявка отправлена в банк")
            db.commit()
            app_id = app.id
        drain(session_factory)
        if then:
            _client_follow_up(session_factory, app_id, then)
    log.info("seed: history created")


def _client_follow_up(session_factory, app_id: str, then: str) -> None:
    import hashlib

    with session_factory() as db:
        app = db.get(Application, app_id)
        if app.status not in (S.APPROVED, S.COUNTER_OFFER):
            return
        actor = Actor("CLIENT", app.created_by, "Клиент")
        app.offer = {**app.offer, "selected_index": 0}
        transition(db, app, S.OFFER_ACCEPTED, actor, "Предложение принято")
        db.commit()
    drain(session_factory)
    if then != "DISBURSE":
        return
    with session_factory() as db:
        app = db.get(Application, app_id)
        app.sign_code_hash = hashlib.sha256(f"{app.id}:000000".encode()).hexdigest()
        app.loan = {**app.loan, "signed_by": "Клиент", "signed_at": date.today().isoformat()}
        transition(db, app, S.SIGNED, Actor("CLIENT", app.created_by, "Клиент"), "Договор подписан простой электронной подписью")
        db.commit()
    drain(session_factory)


def ensure_settings_logged() -> None:
    s = get_settings()
    log.info("settings", extra={"env": s.environment, "inline": s.run_pipeline_inline, "llm": s.llm_enabled})
