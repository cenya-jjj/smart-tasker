import crypto from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";

initializeApp();

const db = getFirestore();
const botTokenSecret = defineSecret("TELEGRAM_BOT_TOKEN");

function json(res, code, data) {
  res.status(code);
  res.set("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(data));
}

function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = params.get("auth_date");
  if (!hash || !authDate) {
    throw new Error("Некорректный initData");
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  return { hash, authDate: Number(authDate), dataCheckString, params };
}

function verifyTelegramInitData(initData, botToken) {
  const { hash, authDate, dataCheckString, params } = parseInitData(initData);
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const sign = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (sign !== hash) {
    throw new Error("Подпись Telegram не прошла проверку");
  }

  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > 3600) {
    throw new Error("Сессия Telegram устарела");
  }

  const rawUser = params.get("user");
  if (!rawUser) throw new Error("Не найден user в initData");
  return JSON.parse(rawUser);
}

async function telegramApi(method, payload, botToken) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!data.ok) {
    throw new Error(data.description || "Telegram API error");
  }
  return data.result;
}

function taskLine(task) {
  const title = task.title || "Без названия";
  const due = task.dueDate || "без дедлайна";
  const status = (task.status || "plan").toUpperCase();
  return `- ${title} | ${status} | ${due}`;
}

function randomCode(size = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

async function resolveUidByTelegramId(telegramId) {
  const mapDoc = await db.collection("telegramIdentity").doc(String(telegramId)).get();
  if (mapDoc.exists) {
    const mappedUid = mapDoc.data()?.uid;
    if (mappedUid) return String(mappedUid);
  }
  return `tg_${telegramId}`;
}

async function applyTelegramProfileToUser(uid, tgUser, chatId = null) {
  await db.collection("users").doc(uid).set({
    telegram: {
      id: tgUser.id,
      username: tgUser.username || "",
      firstName: tgUser.first_name || "",
      lastName: tgUser.last_name || "",
      chatId: chatId ?? null
    },
    updatedAt: new Date().toISOString()
  }, { merge: true });
}

async function linkTelegramToUidByCode({ code, tgUser, chatId }) {
  const codeUp = String(code || "").trim().toUpperCase();
  if (!codeUp) throw new Error("Код привязки пуст");
  const now = Date.now();
  const snap = await db.collection("users")
    .where("telegramLinkCode.code", "==", codeUp)
    .limit(1)
    .get();

  if (snap.empty) throw new Error("Код привязки не найден");
  const userDoc = snap.docs[0];
  const data = userDoc.data() || {};
  const expiresAt = Number(data.telegramLinkCode?.expiresAt || 0);
  if (!expiresAt || expiresAt < now) throw new Error("Код привязки истек");

  await db.collection("telegramIdentity").doc(String(tgUser.id)).set({
    uid: userDoc.id,
    linkedAt: new Date().toISOString()
  }, { merge: true });

  await applyTelegramProfileToUser(userDoc.id, tgUser, chatId);
  await userDoc.ref.set({ telegramLinkCode: null, updatedAt: new Date().toISOString() }, { merge: true });
  return userDoc.id;
}

export const telegramAuth = onRequest(
  { region: "us-central1", cors: true, secrets: [botTokenSecret] },
  async (req, res) => {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    try {
      const initData = req.body?.initData;
      if (!initData) return json(res, 400, { error: "initData required" });
      const botToken = botTokenSecret.value();
      const tgUser = verifyTelegramInitData(initData, botToken);

      const uid = await resolveUidByTelegramId(tgUser.id);
      const auth = getAuth();
      await auth.createUser({
        uid,
        displayName: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ").trim() || `tg_${tgUser.id}`
      }).catch((e) => {
        if (e.code !== "auth/uid-already-exists") throw e;
      });

      await db.collection("users").doc(uid).set({
        displayName: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ").trim() || `Telegram#${String(tgUser.id).slice(-6)}`,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      await applyTelegramProfileToUser(uid, tgUser, null);

      const customToken = await auth.createCustomToken(uid, {
        provider: "telegram",
        telegramId: String(tgUser.id)
      });
      return json(res, 200, { customToken, uid });
    } catch (err) {
      return json(res, 401, { error: err.message || "Auth failed" });
    }
  }
);

export const createTelegramLinkCode = onRequest(
  { region: "us-central1", cors: true },
  async (req, res) => {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    try {
      const authHeader = String(req.headers.authorization || "");
      const m = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!m) return json(res, 401, { error: "Authorization Bearer token required" });
      const decoded = await getAuth().verifyIdToken(m[1]);
      const uid = decoded.uid;

      const code = randomCode(8);
      const expiresAt = Date.now() + 10 * 60 * 1000;
      await db.collection("users").doc(uid).set({
        telegramLinkCode: { code, expiresAt, createdAt: Date.now() },
        updatedAt: new Date().toISOString()
      }, { merge: true });
      return json(res, 200, { code, expiresAt });
    } catch (err) {
      return json(res, 401, { error: err.message || "Unauthorized" });
    }
  }
);

export const telegramLinkByCode = onRequest(
  { region: "us-central1", cors: true, secrets: [botTokenSecret] },
  async (req, res) => {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    try {
      const initData = req.body?.initData;
      const code = req.body?.code;
      if (!initData || !code) return json(res, 400, { error: "initData and code required" });
      const botToken = botTokenSecret.value();
      const tgUser = verifyTelegramInitData(initData, botToken);
      const uid = await linkTelegramToUidByCode({ code, tgUser, chatId: null });
      return json(res, 200, { ok: true, uid });
    } catch (err) {
      return json(res, 400, { error: err.message || "Link failed" });
    }
  }
);

export const telegramWebhook = onRequest(
  { region: "us-central1", secrets: [botTokenSecret] },
  async (req, res) => {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const update = req.body || {};
    const message = update.message;
    if (!message?.chat?.id) return json(res, 200, { ok: true });
    try {
      const botToken = botTokenSecret.value();
      const chatId = message.chat.id;
      const appUrl = "https://talkerj.web.app/miniapp.html";
      const text = String(message.text || "").trim().toLowerCase();
      const tgUser = message.from || {};

      if (text.startsWith("/link ")) {
        const rawCode = String(message.text || "").split(" ").slice(1).join(" ").trim();
        try {
          await linkTelegramToUidByCode({ code: rawCode, tgUser, chatId });
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text: "Готово. Telegram привязан к вашему аккаунту по почте. Теперь мини-апп откроет те же задачи."
          }, botToken);
        } catch (e) {
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text: `Не получилось привязать: ${e.message}`
          }, botToken);
        }
      } else {
        const uid = await resolveUidByTelegramId(message.from.id);
        await applyTelegramProfileToUser(uid, tgUser, chatId);
      }

      if (text === "/today" || text === "сегодня") {
        const uid = await resolveUidByTelegramId(message.from.id);
        const today = new Date().toISOString().slice(0, 10);
        const snap = await db.collection("tasks")
          .where("userId", "==", uid)
          .where("itemType", "==", "task")
          .where("status", "!=", "done")
          .limit(50)
          .get();
        const rows = snap.docs
          .map((d) => d.data())
          .filter((t) => !t.dueDate || t.dueDate <= today)
          .slice(0, 12);

        const body = rows.length
          ? `Задачи на сегодня:\n${rows.map(taskLine).join("\n")}`
          : "На сегодня активных задач нет.";

        await telegramApi("sendMessage", { chat_id: chatId, text: body }, botToken);
      }

      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: "Открой мини-приложение Smart Tasker.\nКоманды: /today и /link XXXXXXXX (привязка к email-аккаунту).",
        reply_markup: {
          inline_keyboard: [[{
            text: "Открыть мини-апп",
            web_app: { url: appUrl }
          }]]
        }
      }, botToken);

      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 500, { error: err.message || "Webhook error" });
    }
  }
);

export const telegramTaskReminders = onSchedule(
  { region: "us-central1", schedule: "every 60 minutes", secrets: [botTokenSecret] },
  async () => {
    const botToken = botTokenSecret.value();
    const today = new Date().toISOString().slice(0, 10);
    const usersSnap = await db.collection("users").where("telegram.chatId", "!=", null).limit(500).get();

    for (const userDoc of usersSnap.docs) {
      const userId = userDoc.id;
      if (!userId.startsWith("tg_")) continue;
      const telegram = userDoc.data().telegram || {};
      const chatId = telegram.chatId;
      if (!chatId) continue;

      const tasksSnap = await db.collection("tasks")
        .where("userId", "==", userId)
        .where("itemType", "==", "task")
        .where("status", "!=", "done")
        .limit(100)
        .get();

      const dueTasks = tasksSnap.docs.filter((docSnap) => {
        const task = docSnap.data();
        if (!task.dueDate) return false;
        if (task.dueDate > today) return false;
        const lastReminderDate = task.lastReminderDate || "";
        return lastReminderDate !== today;
      });

      if (!dueTasks.length) continue;

      const text = `Напоминание по задачам:\n${dueTasks.slice(0, 8).map((d) => taskLine(d.data())).join("\n")}`;
      await telegramApi("sendMessage", { chat_id: chatId, text }, botToken);

      await Promise.all(dueTasks.map((docSnap) =>
        docSnap.ref.update({
          lastReminderDate: today,
          updatedAt: new Date().toISOString()
        })
      ));
    }
  }
);
