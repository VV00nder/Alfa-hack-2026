# Диаграмма состояний заявки

Источник истины — [`backend/app/state_machine.py`](../backend/app/state_machine.py). Любой недопустимый переход отклоняется с `409 Conflict`. Справочник доступен в API: `GET /api/v1/meta/statuses`.

```mermaid
stateDiagram-v2
  [*] --> DRAFT: клиент создал заявку
  DRAFT --> SUBMITTED: клиент отправил
  SUBMITTED --> VALIDATION: конвейер принял
  VALIDATION --> INFO_REQUESTED: не хватает данных или документов
  VALIDATION --> ENRICHMENT: данные полные
  VALIDATION --> REJECTED: параметры вне условий продукта
  INFO_REQUESTED --> SUBMITTED: клиент ответил
  ENRICHMENT --> INFO_REQUESTED: выручка расходится с ФНС более чем на 35%
  ENRICHMENT --> SCORING: сведения получены
  SCORING --> APPROVED: автоматическое одобрение
  SCORING --> COUNTER_OFFER: нужны другие условия
  SCORING --> MANUAL_REVIEW: триггеры экспертизы
  SCORING --> REJECTED: стоп-факторы или рейтинг E
  MANUAL_REVIEW --> APPROVED: аналитик
  MANUAL_REVIEW --> COUNTER_OFFER: аналитик
  MANUAL_REVIEW --> REJECTED: аналитик
  MANUAL_REVIEW --> INFO_REQUESTED: аналитик запросил данные
  MANUAL_REVIEW --> COMMITTEE_REVIEW: сумма больше 15 млн или передача на комитет
  COMMITTEE_REVIEW --> APPROVED: риск-менеджер
  COMMITTEE_REVIEW --> COUNTER_OFFER: риск-менеджер
  COMMITTEE_REVIEW --> REJECTED: риск-менеджер
  COMMITTEE_REVIEW --> MANUAL_REVIEW: возврат на доработку
  APPROVED --> OFFER_ACCEPTED: клиент принял
  COUNTER_OFFER --> OFFER_ACCEPTED: клиент выбрал вариант
  OFFER_ACCEPTED --> SIGNING: договор и код ПЭП сформированы
  SIGNING --> SIGNED: клиент подписал кодом
  SIGNED --> DISBURSED: АБС выдала средства
  DISBURSED --> [*]
  REJECTED --> [*]
  CANCELLED --> [*]
  note right of CANCELLED
    Клиент может отозвать заявку
    из любого статуса до SIGNED
  end note
```

## Статусы

| Статус | Для клиента | Этап (1–6) | Кто переводит дальше | Автоэтап конвейера |
|---|---|---|---|---|
| `DRAFT` | Черновик | 1 Заявка | Клиент | — |
| `SUBMITTED` | Отправлена | 2 Проверка | Система | `ACCEPT` |
| `VALIDATION` | Проверка данных | 2 Проверка | Система | `VALIDATE` |
| `INFO_REQUESTED` | Нужна информация | 2 Проверка | Клиент | — |
| `ENRICHMENT` | Запрос данных | 3 Оценка | Система | `ENRICH` |
| `SCORING` | Оценка | 3 Оценка | Система | `SCORE` |
| `MANUAL_REVIEW` | У специалиста | 3 Оценка | Аналитик, риск-менеджер | — |
| `COMMITTEE_REVIEW` | На согласовании | 3 Оценка | Риск-менеджер | — |
| `APPROVED` | Одобрена | 4 Решение | Клиент | — |
| `COUNTER_OFFER` | Есть предложение | 4 Решение | Клиент | — |
| `REJECTED` | Отказ | 4 Решение | — (финал) | — |
| `OFFER_ACCEPTED` | Готовим документы | 5 Договор | Система | `PREPARE_DOCS` |
| `SIGNING` | Подписание | 5 Договор | Клиент | — |
| `SIGNED` | Подписан | 5 Договор | Система | `DISBURSE` |
| `DISBURSED` | Деньги выданы | 6 Деньги | — (финал) | — |
| `CANCELLED` | Отменена | — | — (финал) | — |

## Что происходит при каждом переходе

1. Проверка допустимости по таблице `TRANSITIONS`.
2. Обновление статуса и временных меток: `submitted_at`, `decided_at`, `closed_at`.
3. Запись `ApplicationEvent`: кто, когда, откуда, куда, сообщение. Это аудит для банка и таймлайн для клиента.
4. Уведомление клиенту в кабинете (тип `ACTION_REQUIRED`, если нужен ответ клиента).
5. Постановка задачи `PipelineTask`, если у нового статуса есть автоматический этап.

Шаги 2–5 выполняются в одной транзакции БД.

## Роли и разрешённые действия

| Действие | CLIENT | ANALYST | RISK_MANAGER | ADMIN |
|---|---|---|---|---|
| Создать, заполнить, отправить, отозвать свою заявку | ✓ | | | |
| Ответить на запрос, принять предложение, подписать | ✓ | | | |
| Видеть очередь и карточки заявок | | ✓ | ✓ | ✓ |
| Решение в `MANUAL_REVIEW` | | ✓ | ✓ | ✓ |
| Решение в `COMMITTEE_REVIEW` | | | ✓ | ✓ |
| Публикация материалов ленты | | | | ✓ |
| Журнал аудита | | | ✓ | ✓ |
