# Telegram Mini App + Firebase setup

Этот проект теперь содержит:

- `miniapp.html` — мобильный клиент для Telegram WebApp
- `link-telegram.html` — страница генерации кода привязки Telegram к email-аккаунту
- `functions/index.js` — webhook бота + Telegram auth (`customToken`) + напоминания по задачам
- `firebase.json` и `.firebaserc` для деплоя хостинга/функций

## 1) Подготовить Firebase Functions

```bash
cd functions
npm install
```

## 2) Задать секрет токена Telegram бота

```bash
firebase functions:secrets:set TELEGRAM_BOT_TOKEN
```

## 3) Деплой

```bash
firebase deploy --only functions,hosting
```

После деплоя получатся URL:

- `https://us-central1-talkerj.cloudfunctions.net/telegramAuth`
- `https://us-central1-talkerj.cloudfunctions.net/telegramWebhook`

Также появится scheduler-функция:

- `telegramTaskReminders` — отправляет напоминания по просроченным/сегодняшним задачам каждый час

## 4) Привязать webhook бота

Подставьте `TELEGRAM_BOT_TOKEN` и вызовите:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://us-central1-talkerj.cloudfunctions.net/telegramWebhook"}'
```

## 5) Проверка

1. Напишите боту любое сообщение.
2. Бот пришлет кнопку `Открыть мини-апп`.
3. Мини-апп откроет `miniapp.html`, пройдет вход по Telegram и покажет задачи из коллекции `tasks`.
4. В боте работает команда `/today` для быстрых задач на сегодня.

## Привязка email-аккаунта и Telegram

Чтобы Telegram mini app использовал тот же `uid`, что и вход по почте:

1. Откройте `https://talkerj.web.app/link-telegram.html`
2. Войдите по email/паролю (тот же аккаунт, что в основном таскере).
3. Нажмите `Сгенерировать код привязки`.
4. Отправьте боту команду:

```text
/link ABCD1234
```

5. После подтверждения ботом откройте mini app снова — данные будут общими.

## Важно по данным

- Записи не теряются: используется существующий проект Firebase `talkerj`.
- Новые задачи пишутся в ту же коллекцию `tasks` в совместимом формате (`itemType: "task"`, `space: "personal"`).
- Пользователь Telegram хранится как Firebase UID вида `tg_<telegram_id>`.

## Что можно добавить следующим шагом

- AI-разбор входящих сообщений бота в задачи/заметки.
- Напоминания в Telegram по `dueDate`.
- Экран подтверждения распознанных задач перед сохранением.
