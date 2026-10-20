# Модель данных

СУБД — PostgreSQL 16, схема управляется миграциями Alembic ([`backend/migrations`](../backend/migrations)). Слабоструктурированные данные (анкета, ответы источников, результат скоринга, предложение) хранятся в `JSONB`: структура внешних ответов меняется чаще схемы, а снимок данных на момент решения нужен для аудита.

```mermaid
erDiagram
  COMPANIES ||--o{ USERS : "сотрудники компании"
  COMPANIES ||--o{ APPLICATIONS : "подаёт"
  PRODUCTS ||--o{ APPLICATIONS : "по продукту"
  USERS ||--o{ APPLICATIONS : "создал / назначен"
  APPLICATIONS ||--o{ APPLICATION_EVENTS : "история и аудит"
  APPLICATIONS ||--o{ DOCUMENTS : "документы"
  APPLICATIONS ||--o{ PIPELINE_TASKS : "задачи конвейера"
  COMPANIES ||--o{ NOTIFICATIONS : "уведомления"
  APPLICATIONS ||--o{ NOTIFICATIONS : "по заявке"
  NEWS_ITEMS ||--o{ NEWS_INTERACTIONS : "реакции"
  USERS ||--o{ NEWS_INTERACTIONS : "реагирует"

  COMPANIES {
    uuid id PK
    string inn UK "10/12 цифр, контрольная сумма"
    string ogrn
    string name
    string legal_form "OOO | IP"
    string okved
    string region
    date registration_date
    string segment "micro | small | medium"
  }
  USERS {
    uuid id PK
    string email UK
    string password_hash "bcrypt"
    string role "CLIENT | ANALYST | RISK_MANAGER | ADMIN"
    uuid company_id FK "только для CLIENT"
  }
  PRODUCTS {
    string code PK "EXPRESS, GOV_1764, WORKING_CAPITAL, INVEST, OVERDRAFT"
    float min_amount
    float max_amount
    int min_term
    int max_term
    float margin "надбавка к ключевой ставке"
    bool collateral_required
    bool guarantee_required
    bool requires_account
    jsonb purposes
    jsonb eligible_okved_prefixes
    jsonb required_documents
  }
  APPLICATIONS {
    uuid id PK
    string number UK "CF-ГГММДД-XXXX"
    uuid company_id FK
    string product_code FK
    float amount
    int term_months
    string purpose
    string status "см. state-machine.md"
    jsonb form_data "анкета: финансы, залог, контакт"
    jsonb consents "БКИ, ПДн, дата"
    jsonb validation "результат проверки полноты"
    jsonb enrichment "снимок ответов всех источников"
    jsonb scoring "версия модели, баллы, факторы, DSCR, исход"
    jsonb decision "исход, кто принял, причины, предложение аналитика"
    jsonb offer "варианты, условия, срок действия, выбор"
    jsonb info_request "что запрошено, ответ клиента"
    jsonb loan "договор, счёт, график"
    int info_rounds
    uuid assigned_to FK
    string sign_code_hash "sha256, код не хранится"
    int version "оптимистическая блокировка"
    timestamptz submitted_at
    timestamptz decided_at
    timestamptz closed_at
  }
  APPLICATION_EVENTS {
    uuid id PK
    uuid application_id FK
    timestamptz created_at
    string event_type "STATUS_CHANGED, SCORING_DONE, DOCUMENT_UPLOADED..."
    string from_status
    string to_status
    string actor_type "CLIENT | SYSTEM | EMPLOYEE"
    string actor_name
    text message
    jsonb details
    bool visible_to_client
  }
  DOCUMENTS {
    uuid id PK
    uuid application_id FK
    string doc_type "FIN_STATEMENTS, BANK_STATEMENT, COLLATERAL_DOCS, OTHER, CONTRACT"
    string filename
    int size
    string sha256
    bytea content
    jsonb parsed "распознанная выписка"
  }
  PIPELINE_TASKS {
    uuid id PK
    uuid application_id FK
    string stage "ACCEPT, VALIDATE, ENRICH, SCORE, PREPARE_DOCS, DISBURSE"
    string status "PENDING | RUNNING | DONE | FAILED"
    int attempts
    timestamptz run_after
    text last_error
  }
  NOTIFICATIONS {
    uuid id PK
    uuid company_id FK
    uuid application_id FK
    string kind "STATUS | ACTION_REQUIRED | SIGN_CODE"
    string title
    text body
    bool is_read
  }
  NEWS_ITEMS {
    uuid id PK
    string title
    string category
    jsonb tags "okved, regions, segments, legal_forms, products, statuses"
    int priority
    timestamptz published_at
    bool is_active
  }
  NEWS_INTERACTIONS {
    uuid id PK
    uuid user_id FK
    uuid news_id FK
    string action "CLICK | HIDE | LIKE"
  }
  AUDIT_LOG {
    uuid id PK
    timestamptz created_at
    string actor_email
    string action "LOGIN, LOGIN_FAILED, DECISION_*, CONTRACT_SIGNED, NEWS_CREATED..."
    string entity
    string entity_id
    string ip
    jsonb details
  }
```

## Ключевые решения

* **Снимок данных на момент решения.** `enrichment` и `scoring.features` хранят ровно те данные, на которых принято решение, и версию модели (`scoring.model_version`). Решение можно воспроизвести и объяснить, даже если данные в источниках изменились.
* **Журнал событий — единый источник истории.** Таймлайн клиента — это события с `visible_to_client = true`. Внутренние события (скоринг, решения аналитика, ошибки конвейера) видят только сотрудники.
* **Очередь задач в той же БД** — transactional outbox: статус и задача фиксируются атомарно.
* **Код подписи не хранится**, только `sha256(application_id:code)`.
* **Индексы**: `applications(status)`, `applications(company_id)`, `application_events(application_id)`, `pipeline_tasks(status, run_after)`, уникальные `companies.inn`, `users.email`, `applications.number`.

## Синтетические данные

| Набор | Где | Состав |
|---|---|---|
| Профили внешних источников | [`mocks/fixtures.json`](../mocks/fixtures.json) | 10 компаний: ЕГРЮЛ, ФНС, БКИ, счета, антифрод |
| Генератор для любого ИНН | `mocks/app.py → generated_profile()` | Детерминированно по хэшу ИНН |
| Продукты, пользователи, новости, история заявок | [`backend/app/seed.py`](../backend/app/seed.py) | 5 продуктов, 7 демо-учёток, 18 материалов, 6 заявок, прогнанных через конвейер |
| Выписка по счёту | [`testdata/bank_statement_sample.csv`](../testdata/bank_statement_sample.csv) | 12 месяцев операций |
