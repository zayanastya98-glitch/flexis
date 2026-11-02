// Telegram-бот для отработки чанков на Cloudflare Workers.
// Настройка описана в README.md.
import { Database } from "./db.js";

const CARDS = "🃏 Карточки";
const FRAMES = "✍️ Закончи фразу";
const NOTIFICATIONS = "🔔 Уведомления";
const ADD_CHUNK = "➕ Добавить чанк";
// Сколько чанков студент может добавить одним сообщением.
const MAX_STUDENT_CHUNKS = 20;
const MENU = {
  keyboard: [
    [{ text: CARDS }, { text: FRAMES }],
    [{ text: ADD_CHUNK }, { text: NOTIFICATIONS }],
  ],
  resize_keyboard: true,
};
const ADD_FORMAT =
  "Пришли чанки, каждый с новой строки:\n" +
  "чанк | перевод | пример для студента | начало фразы\n\n" +
  "Например:\n" +
  "used to | раньше (привычка) | I used to teach in a school. | I used to...\n\n" +
  "Обязателен только чанк. /cancel — отмена.";
const STUDENT_ADD_FORMAT =
  "Пришли чанк. Можно добавить несколько, каждый с новой строки.\n\n" +
  "Перевод, пример и начало фразы необязательны, их можно написать через |:\n" +
  "чанк | перевод | пример | начало фразы\n\n" +
  "Например:\n" +
  "used to | раньше | I used to live in Moscow. | I used to...\n\n" +
  "/cancel — отмена.";
const TEACHER_HELP =
  "Команды преподавателя:\n" +
  "/addstudent Имя — создать студента и его ID\n" +
  "/students — список студентов и их ID\n" +
  "/add — добавить лексику\n" +
  "/list — посмотреть лексику студента\n" +
  "/delete номер — удалить чанк\n" +
  "/answers — последние ответы студентов";

let schemaReady = false;

async function openDb(env) {
  const db = new Database(env.DB);
  if (!schemaReady) {
    await db.init();
    schemaReady = true;
  }
  return db;
}

function clock(env) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.TIMEZONE || "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

async function telegram(env, method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram ${method}: ${result.description}`);
  }
  return result.result;
}

function send(env, chatId, text, replyMarkup) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function isTeacher(env, userId) {
  return Boolean(env.TEACHER_ID) && String(userId) === String(env.TEACHER_ID).trim();
}

// Разбирает строки «чанк | перевод | пример | начало фразы».
export function parseChunks(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const parts = line.split("|").map((part) => part.trim());
    if (!parts[0]) continue;
    rows.push([parts[0], parts[1] || "", parts[2] || "", parts[3] || ""]);
  }
  return rows;
}

function cardDetails(chunk) {
  const lines = [chunk.text];
  if (chunk.translation) lines.push(`Перевод: ${chunk.translation}`);
  if (chunk.example) lines.push(`Пример: ${chunk.example}`);
  return lines.join("\n");
}

function inline(text, data) {
  return { text, callback_data: data };
}

function notificationsKeyboard(student) {
  const mark = (value) => (value ? "✅" : "⬜️");
  return {
    inline_keyboard: [
      [inline(`${mark(student.notify_chunk)} Чанк дня с примером`, "notify:chunk")],
      [inline(`${mark(student.notify_frame)} Задание «Закончи фразу»`, "notify:frame")],
      [inline(`${mark(student.notify_train)} Напоминание о карточках`, "notify:train")],
      [inline(`🕒 Время: ${student.notify_time}`, "settime")],
    ],
  };
}

async function studentPicker(db, prefix, includeAll) {
  const rows = (await db.students()).map((row) => [
    inline(row.name, `${prefix}:${row.id}`),
  ]);
  if (includeAll && rows.length) {
    rows.push([inline("Всем студентам", `${prefix}:all`)]);
  }
  return { inline_keyboard: rows };
}

// ---------- Команды ----------
async function onCommand(env, db, message, command, argument) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const teacher = isTeacher(env, userId);

  if (command === "start") {
    await db.clearState(userId);
    const student = await db.studentByTelegram(userId);
    if (student) {
      await send(env, chatId, `Привет, ${student.name}! Что потренируем?`, MENU);
    } else if (teacher) {
      await send(env, chatId, TEACHER_HELP);
    } else {
      await send(env, chatId, "Привет! Введи свой ID от преподавателя.");
    }
    return;
  }
  if (command === "myid") {
    await send(env, chatId, `Твой Telegram ID: ${userId}`);
    return;
  }
  if (command === "cancel") {
    await db.clearState(userId);
    await send(env, chatId, "Отменено.");
    return;
  }
  if (!teacher) return;

  if (command === "help") {
    await send(env, chatId, TEACHER_HELP);
  } else if (command === "addstudent") {
    if (!argument) {
      await send(env, chatId, "Напиши так: /addstudent Анна");
      return;
    }
    await send(env, chatId, `${argument}: ID ${await db.addStudent(argument)}`);
  } else if (command === "students") {
    const rows = await db.students();
    if (!rows.length) {
      await send(env, chatId, "Студентов пока нет: /addstudent Имя");
      return;
    }
    const lines = rows.map(
      (row) =>
        `${row.name}: ${row.code} (${row.telegram_id ? "подключён" : "не подключён"})`,
    );
    await send(env, chatId, lines.join("\n").slice(0, 4000));
  } else if (command === "add" || command === "list") {
    if (!(await db.students()).length) {
      await send(env, chatId, "Сначала создай студента: /addstudent Имя");
      return;
    }
    await send(
      env,
      chatId,
      command === "add" ? "Кому добавить лексику?" : "Чью лексику показать?",
      await studentPicker(db, command === "add" ? "addfor" : "listfor", command === "add"),
    );
  } else if (command === "delete") {
    if (!/^\d+$/.test(argument)) {
      await send(env, chatId, "Напиши так: /delete 12. Номера есть в /list");
      return;
    }
    const deleted = await db.deleteChunk(Number(argument));
    await send(env, chatId, deleted ? "Удалено." : "Такого номера нет.");
  } else if (command === "answers") {
    const rows = await db.recentAnswers();
    if (!rows.length) {
      await send(env, chatId, "Ответов пока нет.");
      return;
    }
    const text = rows
      .map((row) => `${row.name}\n${row.frame}\n→ ${row.answer}`)
      .join("\n\n");
    await send(env, chatId, text.slice(0, 4000));
  }
}

// ---------- Студент ----------
async function sendCard(env, db, chatId, student) {
  const chunk = await db.nextCard(student.id, clock(env).date);
  if (!chunk) {
    await send(env, chatId, "На сегодня карточек нет. Отличная работа! 🎉");
    return;
  }
  await send(env, chatId, chunk.text, {
    inline_keyboard: [[inline("Показать", `show:${chunk.id}`)]],
  });
}

async function askFrame(env, db, chatId, userId, chunk) {
  await db.setState(userId, { awaiting: "frame", frame: chunk.frame });
  await send(env, chatId, `Закончи фразу о себе:\n\n${chunk.frame}`);
}

async function saveVocabulary(env, db, message, state) {
  const rows = parseChunks(message.text);
  if (!rows.length) {
    await send(env, message.chat.id, ADD_FORMAT);
    return;
  }
  const studentIds =
    state.addingFor === "all"
      ? (await db.students()).map((row) => row.id)
      : [state.addingFor];
  await db.addChunks(studentIds, rows, clock(env).date);
  await db.clearState(message.from.id);
  await send(env, message.chat.id, `Добавлено чанков: ${rows.length}.`);
}

async function saveAnswer(env, db, message, student, state, text) {
  await db.addAnswer(student.id, state.frame, text);
  await db.clearState(message.from.id);
  await send(env, message.chat.id, "Записала! Преподаватель увидит твой ответ. ✅");
  if (env.TEACHER_ID) {
    try {
      await send(env, env.TEACHER_ID, `${student.name}\n${state.frame}\n→ ${text}`);
    } catch (error) {
      console.error("Не удалось переслать ответ преподавателю", error.message);
    }
  }
}

async function saveStudentChunks(env, db, message, student, text) {
  const chatId = message.chat.id;
  const rows = parseChunks(text);
  if (!rows.length) {
    await send(env, chatId, STUDENT_ADD_FORMAT);
    return;
  }
  if (rows.length > MAX_STUDENT_CHUNKS) {
    await send(env, chatId, `За один раз можно добавить до ${MAX_STUDENT_CHUNKS} чанков.`);
    return;
  }
  await db.addChunks([student.id], rows, clock(env).date);
  await db.clearState(message.from.id);
  await send(env, chatId, `Добавлено чанков: ${rows.length}. Они уже в карточках! ✅`);
  if (env.TEACHER_ID) {
    try {
      const list = rows.map((row) => row.filter(Boolean).join(" | ")).join("\n");
      await send(
        env,
        env.TEACHER_ID,
        `${student.name} добавляет лексику:\n\n${list}`.slice(0, 4000),
      );
    } catch (error) {
      console.error("Не удалось уведомить преподавателя", error.message);
    }
  }
}

async function saveTime(env, db, message, student, text) {
  const match = text.match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/);
  if (!match) {
    await send(env, message.chat.id, "Напиши время так: 09:30");
    return;
  }
  const value = `${match[1].padStart(2, "0")}:${match[2]}`;
  const now = clock(env);
  // Если время сегодня уже прошло, первая рассылка будет завтра.
  await db.setNotifyTime(student.id, value, value <= now.time ? now.date : null);
  await db.clearState(message.from.id);
  await send(env, message.chat.id, `Готово, буду писать в ${value}.`);
}

async function onText(env, db, message) {
  const text = message.text.trim();
  const chatId = message.chat.id;
  const userId = message.from.id;
  const state = await db.getState(userId);

  if (isTeacher(env, userId) && state.addingFor !== undefined) {
    await saveVocabulary(env, db, message, state);
    return;
  }

  const student = await db.studentByTelegram(userId);
  if (!student) {
    const name = await db.linkStudent(text, userId);
    if (name) {
      await send(env, chatId, `Привет, ${name}! Всё готово.`, MENU);
    } else {
      await send(env, chatId, "Не нашёл такой ID. Проверь его или спроси преподавателя.");
    }
    return;
  }

  if (text === CARDS) {
    await db.clearState(userId);
    await sendCard(env, db, chatId, student);
  } else if (text === FRAMES) {
    await db.clearState(userId);
    const chunk = await db.randomFrame(student.id);
    if (chunk) {
      await askFrame(env, db, chatId, userId, chunk);
    } else {
      await send(env, chatId, "Заданий пока нет.");
    }
  } else if (text === NOTIFICATIONS) {
    await db.clearState(userId);
    await send(
      env,
      chatId,
      "Выбери, что присылать раз в день:",
      notificationsKeyboard(student),
    );
  } else if (text === ADD_CHUNK) {
    await db.setState(userId, { awaiting: "chunk" });
    await send(env, chatId, STUDENT_ADD_FORMAT);
  } else if (state.awaiting === "chunk") {
    await saveStudentChunks(env, db, message, student, text);
  } else if (state.awaiting === "frame") {
    await saveAnswer(env, db, message, student, state, text);
  } else if (state.awaiting === "time") {
    await saveTime(env, db, message, student, text);
  } else {
    await send(env, chatId, "Выбери действие в меню 👇", MENU);
  }
}

async function onButton(env, db, query) {
  await telegram(env, "answerCallbackQuery", { callback_query_id: query.id });
  const message = query.message;
  if (!message) return;
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const userId = query.from.id;
  const [action, value] = query.data.split(":");
  const id = Number(value);

  if (action === "addfor" || action === "listfor") {
    if (!isTeacher(env, userId)) return;
    if (action === "addfor") {
      await db.setState(userId, { addingFor: value === "all" ? "all" : id });
      await telegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: ADD_FORMAT,
      });
      return;
    }
    const lines = (await db.chunks(id)).map((row) => `${row.id}. ${row.text}`);
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: lines.join("\n").slice(0, 4000) || "Лексики пока нет.",
    });
    return;
  }

  const student = await db.studentByTelegram(userId);
  if (!student) return;

  if (action === "show") {
    const chunk = await db.chunk(id, student.id);
    if (chunk) {
      await telegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: cardDetails(chunk),
        reply_markup: {
          inline_keyboard: [
            [inline("🔁 Повторить", `again:${id}`), inline("✅ Знаю", `know:${id}`)],
          ],
        },
      });
    }
  } else if (action === "know" || action === "again") {
    await db.review(id, student.id, action === "know", clock(env).date);
    await telegram(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
    });
    await sendCard(env, db, chatId, student);
  } else if (action === "notify") {
    await db.toggleNotification(student.id, value);
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "Выбери, что присылать раз в день:",
      reply_markup: notificationsKeyboard(await db.student(student.id)),
    });
  } else if (action === "settime") {
    await db.setState(userId, { awaiting: "time" });
    await send(env, chatId, "Во сколько писать? Например, 09:30");
  } else if (action === "frame") {
    const chunk = await db.chunk(id, student.id);
    if (chunk && chunk.frame) {
      await askFrame(env, db, chatId, userId, chunk);
    }
  }
}

async function onUpdate(env, db, update) {
  if (update.callback_query) {
    await onButton(env, db, update.callback_query);
    return;
  }
  const message = update.message;
  if (!message || !message.text || !message.from) return;
  const command = message.text.match(/^\/([a-zA-Z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
  if (command) {
    await onCommand(
      env,
      db,
      message,
      command[1].toLowerCase(),
      (command[2] || "").trim().replace(/\s+/g, " "),
    );
  } else if (!message.text.startsWith("/")) {
    await onText(env, db, message);
  }
}

// ---------- Ежедневные уведомления ----------
async function sendNotifications(env, db) {
  const { date, time } = clock(env);
  for (const student of await db.studentsToNotify(time, date)) {
    // Отмечаем сразу, чтобы при ошибке не слать повторно каждую минуту.
    await db.markNotified(student.id, date);
    const chatId = student.telegram_id;
    try {
      if (student.notify_chunk) {
        const chunk = await db.nextDailyChunk(student.id, date);
        if (chunk) {
          await send(env, chatId, `Чанк дня ✨\n\n${cardDetails(chunk)}`);
        }
      }
      if (student.notify_frame) {
        const chunk = await db.randomFrame(student.id);
        if (chunk) {
          await send(
            env,
            chatId,
            `Задание дня: закончи фразу о себе\n\n${chunk.frame}`,
            { inline_keyboard: [[inline("Ответить", `frame:${chunk.id}`)]] },
          );
        }
      }
      if (student.notify_train) {
        const due = await db.dueCount(student.id, date);
        if (due) {
          await send(env, chatId, `Карточек на сегодня: ${due}. Нажми «${CARDS}».`);
        }
      }
    } catch (error) {
      console.error(`Не удалось отправить уведомление студенту ${student.id}`, error.message);
    }
  }
}

// ---------- Подключение к Telegram ----------
// Секрет вычисляется из токена, поэтому отдельно его хранить не нужно.
async function webhookSecret(env) {
  const data = new TextEncoder().encode(`webhook:${env.BOT_TOKEN}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function setup(env, origin) {
  if (!env.BOT_TOKEN) {
    return new Response("Не задан BOT_TOKEN. См. README.md", { status: 500 });
  }
  try {
    await openDb(env);
    await telegram(env, "setWebhook", {
      url: `${origin}/telegram`,
      secret_token: await webhookSecret(env),
      allowed_updates: ["message", "callback_query"],
    });
  } catch (error) {
    console.error("Ошибка настройки", error.message);
    return new Response(`Ошибка настройки: ${error.message}`, { status: 500 });
  }
  return new Response("Готово! Бот подключён к Telegram.", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/setup") {
      return setup(env, url.origin);
    }
    if (request.method === "POST" && url.pathname === "/telegram") {
      const header = request.headers.get("x-telegram-bot-api-secret-token");
      if (!env.BOT_TOKEN || header !== (await webhookSecret(env))) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        await onUpdate(env, await openDb(env), await request.json());
      } catch (error) {
        // Отвечаем 200, чтобы Telegram не повторял сообщение снова и снова.
        console.error("Ошибка обработки сообщения", error.message);
      }
      return new Response("ok");
    }
    return new Response("Бот работает.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(openDb(env).then((db) => sendNotifications(env, db)));
  },
};
