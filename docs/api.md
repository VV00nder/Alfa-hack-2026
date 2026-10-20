# API CreditFlow

* Базовый путь: `/api/v1`. Через веб-контейнер: `http://localhost:8080/api/v1`, напрямую: `http://localhost:8000/api/v1`.
* Спецификация: [`api/openapi.json`](api/openapi.json) (OpenAPI 3.1), интерактивно — http://localhost:8000/api/docs.
* Коллекция Postman: [`api/CreditFlow.postman_collection.json`](api/CreditFlow.postman_collection.json). Импортируйте её и запустите папки по порядку в Collection Runner.
* Симулятор внешних систем: [`api/mocks-openapi.json`](api/mocks-openapi.json), http://localhost:8090/docs.

## Авторизация

```http
POST /api/v1/auth/login
Content-Type: application/json

{"email": "bakery@demo.ru", "password": "Demo123!"}
```

```json
{"access_token": "eyJ…", "token_type": "bearer", "user": {"role": "CLIENT", "company": {"inn": "7704123450", "...": "..."}}}
```

Дальше в каждом запросе: `Authorization: Bearer <access_token>`.

## Ошибки

| Код | Когда | Тело |
|---|---|---|
| 401 | Нет токена, токен истёк, неверный пароль | `{"detail": "…"}` |
| 403 | Роль не позволяет действие (клиент → `/bank`, аналитик → решение на комитете) | `{"detail": "Недостаточно прав"}` |
| 404 | Объект не найден **или принадлежит другой компании** (не раскрываем существование) | `{"detail": "Заявка не найдена"}` |
| 409 | Недопустимый переход статуса, параллельное изменение (оптимистическая блокировка) | `{"detail": "Переход DRAFT → APPROVED недопустим"}` |
| 413 / 415 | Файл больше 5 МБ / недопустимый формат | |
| 422 | Ошибка валидации или незаполненная заявка | `{"detail": {"message": "…", "problems": ["…"]}}` или стандартный список pydantic |
| 503 | Внешний источник недоступен (только для синхронных операций, например регистрации) | |

Каждый ответ содержит `X-Request-ID` для поиска в логах.

## Эндпоинты

### Аутентификация

| Метод | Путь | Описание |
|---|---|---|
| POST | `/auth/login` | Вход |
| POST | `/auth/register` | Регистрация предпринимателя по ИНН; компания создаётся из ЕГРЮЛ |
| GET | `/auth/me` | Текущий пользователь |
| GET | `/auth/demo-accounts` | Тестовые учётные записи (только при `SEED_DEMO_DATA=true`) |

### Продукты и компания

| Метод | Путь | Описание |
|---|---|---|
| GET | `/products` | Каталог с минимальной ставкой |
| GET | `/products/{code}` | Карточка продукта |
| POST | `/products/recommend` | Подбор: `{purpose, amount, term_months, has_collateral}` или `{text}` (свободный текст разбирается ассистентом) |
| POST | `/products/calculate` | Калькулятор платежа |
| GET | `/companies/me` | Профиль компании |
| GET | `/companies/me/prefill` | Предзаполнение анкеты из ЕГРЮЛ, ФНС, АБС |

### Заявки (клиент)

| Метод | Путь | Описание | Статус до → после |
|---|---|---|---|
| GET | `/applications` | Мои заявки | |
| POST | `/applications` | Создать черновик | → `DRAFT` |
| GET | `/applications/{id}` | Заявка: статус, этап, подсказка, следующее действие, таймлайн, предложение, объяснение | |
| PATCH | `/applications/{id}` | Автосохранение (частичное обновление) | `DRAFT`, `INFO_REQUESTED` |
| POST | `/applications/{id}/submit` | Отправить (идемпотентно) | `DRAFT → SUBMITTED` |
| POST | `/applications/{id}/documents` | Загрузить документ (multipart: `doc_type`, `file`); CSV-выписка распознаётся | `DRAFT`, `INFO_REQUESTED` |
| GET | `/applications/{id}/documents/{doc_id}` | Скачать документ / договор | |
| DELETE | `/applications/{id}/documents/{doc_id}` | Удалить документ | `DRAFT`, `INFO_REQUESTED` |
| POST | `/applications/{id}/info-response` | Ответ на запрос банка | `INFO_REQUESTED → SUBMITTED` |
| POST | `/applications/{id}/accept-offer` | Принять вариант `{option_index}` | `APPROVED/COUNTER_OFFER → OFFER_ACCEPTED` |
| POST | `/applications/{id}/sign` | Подписать кодом ПЭП `{code}` | `SIGNING → SIGNED` |
| POST | `/applications/{id}/cancel` | Отозвать заявку | `* → CANCELLED` |

### Уведомления, лента, ассистент

| Метод | Путь | Описание |
|---|---|---|
| GET | `/notifications` | Уведомления компании (статусы, запросы, код подписи) |
| POST | `/notifications/read-all` | Отметить прочитанными |
| GET | `/news/feed` | Персональная лента с `relevance` и `reasons` |
| POST | `/news/{id}/interact` | Реакция `CLICK` / `LIKE` / `HIDE` (влияет на ранжирование) |
| POST | `/assistant/chat` | Вопрос ассистенту `{message, application_id?}` → `{answer, engine, parsed?, recommendations?}` |
| GET | `/assistant/status` | Режим ассистента и доступность LLM |

### Рабочее место банка (роли ANALYST, RISK_MANAGER, ADMIN)

| Метод | Путь | Описание |
|---|---|---|
| GET | `/bank/applications?status=&q=&product=&mine=` | Очередь с фильтрами |
| GET | `/bank/applications/{id}` | Полная карточка: `enrichment`, `scoring`, все события |
| POST | `/bank/applications/{id}/assign` | Взять в работу |
| GET | `/bank/applications/{id}/ai-summary` | Резюме для андеррайтера |
| POST | `/bank/applications/{id}/what-if?amount=&term_months=&product_code=` | Пересчёт модели без сохранения |
| POST | `/bank/applications/{id}/decision` | Решение: `APPROVE`, `COUNTER_OFFER`, `REJECT`, `REQUEST_INFO`, `TO_COMMITTEE`, `RETURN_TO_ANALYST` |
| GET | `/bank/dashboard` | Метрики конвейера |
| GET | `/bank/events` | Лента активности по заявкам |
| GET | `/bank/audit` | Журнал аудита (RISK_MANAGER, ADMIN) |
| GET | `/bank/companies` | Компании (для предпросмотра ленты) |
| GET / POST | `/bank/news` | Материалы ленты / публикация с таргетингом (ADMIN) |
| DELETE | `/bank/news/{id}` | Снять с публикации (ADMIN) |
| GET | `/bank/news/preview?company_id=` | Лента глазами конкретной компании |

### Служебные

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/health/live` | Liveness |
| GET | `/api/health/ready` | Readiness: БД, внешние системы, LLM |
| GET | `/metrics` | Prometheus |
| GET | `/api/v1/meta/statuses` | Справочник статусов и переходов |

## Пример: решение аналитика

```http
POST /api/v1/bank/applications/{id}/decision
Authorization: Bearer <token аналитика>
Content-Type: application/json

{
  "action": "COUNTER_OFFER",
  "amount": 2500000,
  "term_months": 18,
  "rate": 24.0,
  "comment": "Снижение лимита до уровня денежного потока"
}
```

Если сумма больше 15 млн ₽ и решение принимает аналитик, заявка переходит в `COMMITTEE_REVIEW`, а его предложение сохраняется в `decision.proposal` до согласования риск-менеджером.

## Пример: запрос информации у клиента

```json
{
  "action": "REQUEST_INFO",
  "comment": "Нужна расшифровка дебиторской задолженности",
  "info_items": ["Расшифровка дебиторской задолженности на последнюю отчётную дату"],
  "request_doc_types": ["FIN_STATEMENTS"]
}
```

## Контракты симулятора внешних систем

| Система | Запрос | Ключевые поля ответа |
|---|---|---|
| ЕГРЮЛ/ЕГРИП | `GET /egrul/v1/companies/{inn}` | `status`, `registration_date`, `okved_main`, `director`, `founders`, `region`, `msp_category` |
| ФНС «Прозрачный бизнес» | `GET /fns/v1/transparent-business/{inn}` | `revenue_last_year`, `expenses_last_year`, `tax_arrears`, `flags{mass_address, unreliable_info, disqualified_director}` |
| БКИ | `POST /bki/v1/reports {inn, consent_id}` | `score`, `max_overdue_days_12m`, `current_overdue_days`, `inquiries_30d`, `active_loans[]` |
| Антифрод | `POST /antifraud/v1/check {inn, amount, channel}` | `risk_level`, `reasons` |
| АБС: счета | `GET /abs/v1/accounts/{inn}` | `is_client`, `account_months`, `avg_monthly_inflow` |
| АБС: выдача | `POST /abs/v1/loans {application_id, …}` | `loan_id`, `account`, `disbursed_at` (идемпотентно) |
| Управление сбоями | `POST /admin/chaos {source, failure_rate}` | Текущая карта сбоев |
