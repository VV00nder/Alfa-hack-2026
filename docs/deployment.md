# Публикация и сдача

## 1. Чек-лист сдачи (по требованиям кейса)

- [ ] Код в GitHub-репозитории с историей коммитов; для приватного репозитория выдан доступ аккаунту жюри **`alfa-hack-2026`** (Settings → Collaborators).
- [ ] Версия на момент дедлайна зафиксирована тегом: `git tag -a v1.0.0 -m "Альфа-Хак 2026: сдача" && git push origin v1.0.0`. В форме сдачи указаны тег и `git rev-parse HEAD`.
- [ ] `docker compose up --build` на чистой машине поднимает все компоненты (проверено).
- [ ] Версии зафиксированы: `backend/requirements.txt` (с хэшами), `mocks/requirements.txt`, `frontend/package-lock.json`, закреплённые теги образов.
- [ ] README: назначение, архитектура, требования, запуск, переменные, компоненты, сценарий проверки.
- [ ] Синтетические данные и тестовые учётные записи (README §3).
- [ ] `THIRD_PARTY_NOTICES.md`.
- [ ] Архитектурная схема, API, OpenAPI, Postman, диаграмма состояний, модель данных, тестовые сценарии (`docs/`).
- [ ] *(Желательно)* Публичный стенд для демо.

Первая публикация:

```bash
git init && git add . && git commit -m "CreditFlow: умный кредитный кабинет предпринимателя"
git branch -M main
git remote add origin https://github.com/VV00nder/Alfa-hack-2026.git
git push -u origin main
```

## 2. Публичные стенды

### 2.1. Демо на GitHub Pages (уже настроено)

Каждый push в `main` запускает [`.github/workflows/pages.yml`](../.github/workflows/pages.yml): фронтенд собирается с `VITE_DEMO_MODE=true` (API выполняется в браузере) и публикуется на **https://vv00nder.github.io/Alfa-hack-2026/**.

Однократная настройка репозитория: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Pages на бесплатном аккаунте работает только с публичным репозиторием.

### 2.2. Полная версия на сервере (VM с 2 vCPU / 4 ГБ, например Oracle Cloud Always Free, Yandex Cloud, VK Cloud)

1. Направьте A-запись домена на IP сервера (без домена — см. вариант 2.3).
2. На сервере (Ubuntu 22.04+):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/VV00nder/Alfa-hack-2026.git creditflow && cd creditflow
cp .env.example .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
sed -i "s/^DOMAIN=.*/DOMAIN=creditflow.example.ru/" .env      # ваш домен
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

3. Откройте в файрволе облака порты 80 и 443. Через минуту стенд доступен по `https://<домен>`; Swagger — `https://<домен>/api/docs`.

Прод-оверлей [`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml): наружу открыт только Caddy (80/443, автоматический сертификат Let's Encrypt, HSTS); API, моки и БД доступны только внутри сети Docker; секреты обязательны (запуск без них падает с понятной ошибкой); два воркера.

### 2.3. Временный туннель с ноутбука (на время защиты)

```bash
docker compose up -d
cloudflared tunnel --url http://localhost:8080
```

Команда выдаёт временный адрес `https://<random>.trycloudflare.com`.

## 3. Эксплуатация

| Задача | Команда |
|---|---|
| Логи | `docker compose logs -f api worker` |
| Масштабировать воркеры | `docker compose up -d --scale worker=3` |
| Сбросить данные | `docker compose down -v`, затем `docker compose up -d` |
| Бэкап БД | `docker compose exec db pg_dump -U creditflow creditflow > backup.sql` |
| Ускорить конвейер для демо | `PIPELINE_STEP_DELAY_SEC=0.5 docker compose up -d api worker` |
| Включить LLM | `LLM_ENABLED=true docker compose --profile ai up -d` |
| Имитация сбоя БКИ | `curl -X POST localhost:8090/admin/chaos -H "Content-Type: application/json" -d '{"source":"bki","failure_rate":1}'` |

## 4. Частые проблемы

| Симптом | Решение |
|---|---|
| Порт 8080/8000/8090 занят | Освободить порт или поменять левую часть в `ports` в `docker-compose.yml` |
| `migrate` завершился с ошибкой | `docker compose logs migrate`; чаще всего БД не успела стартовать — `docker compose up -d` повторно |
| Пустая очередь у аналитика | Демо-данные загружаются только в пустую БД: `docker compose down -v` и заново |
| Профиль `ai`: ассистент отвечает «по правилам» | Модель ещё скачивается: `docker compose logs ollama-pull` |
| Сборка `--build-context` не работает | Нужен Docker BuildKit (по умолчанию в Docker Desktop и Docker 23+) |
