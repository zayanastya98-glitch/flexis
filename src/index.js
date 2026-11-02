// Telegram-бот для отработки чанков на Cloudflare Workers.
// Настройка описана в README.md.
import { Database } from "./db.js";
import { checkAnswer } from "./feedback.js";
import { compareChunks, findDuplicatePairs } from "./similar.js";

const CARDS = "🃏 Карточки";
const FRAMES = "✍️ Закончи фразу";
const NOTIFICATIONS = "🔔 Уведомления";
const ADD_CHUNK = "➕ Добавить чанк";
const NOTES = "📝 Заметки";
const QUIZ = "🧩 Квиз";
const PROGRESS = "🏅 Прогресс";
// Запас до лимита Telegram: к тексту добавляется заголовок с датой.
const MAX_NOTE_LENGTH = 3900;
const MAX_DUPES_CHECK = 150;
// Сколько вопросов идёт подряд в одном квизе.
const QUIZ_LENGTH = 10;
// Сколько карточек идёт подряд до вопроса «practice ещё или закончить».
const CARD_SESSION = 10;
// Защита от случайных расходов на API.
const MAX_AI_CHECKS_PER_DAY = 30;
// Сколько чанков студент может добавить одним сообщением.
const MAX_STUDENT_CHUNKS = 20;
const MENU = {
  keyboard: [
    [{ text: CARDS }, { text: FRAMES }],
    [{ text: ADD_CHUNK }, { text: NOTES }],
    [{ text: QUIZ }, { text: PROGRESS }],
    [{ text: NOTIFICATIONS }],
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
const welcome = (name) =>
  `Привеет, ${name} :) ` +
  "Надеюсь, этот бот поможет тебе почаще соприкасаться с лексикой с наших уроков. " +
  "Я буду добавлять лексику по мере изучения, но и ты тоже можешь добавлять лексику, " +
  "которая тебе встретилась и тебе хочется ее запомнить.\n\n" +
  "!помним, что мы стараемся работать со словосочетаниями, а не отдельными словами. " +
  "Йеей! давай пробовать!";
const TEACHER_HELP =
  "Команды Насти:\n" +
  "/addstudent Имя — создать студента и его ID\n" +
  "/students — список студентов и их ID\n" +
  "/add — добавить лексику\n" +
  "/note — отправить заметку с урока\n" +
  "/reply — написать студенту от твоего имени\n" +
  "/stats — активность студентов\n" +
  "/dupes — найти повторы в лексике студента\n" +
  "/reset — обнулить прогресс студента\n" +
  "/rename — переименовать студента\n" +
  "/delstudent — удалить студента со всеми данными\n" +
  "/list — посмотреть лексику студента\n" +
  "/delete 12 15 20 — удалить чанки по номерам\n" +
  "/answers — последние ответы студентов\n" +
  "/logout — выйти из аккаунта студента";

const TEACHER_COMMANDS = [
  { command: "add", description: "Добавить лексику" },
  { command: "note", description: "Отправить заметку с урока" },
  { command: "reply", description: "Написать студенту" },
  { command: "stats", description: "Активность студентов" },
  { command: "addstudent", description: "Создать студента: /addstudent Имя" },
  { command: "students", description: "Студенты и их ID" },
  { command: "list", description: "Лексика студента" },
  { command: "answers", description: "Ответы студентов" },
  { command: "delete", description: "Удалить чанки: /delete 12 15" },
  { command: "dupes", description: "Найти повторы в лексике" },
  { command: "reset", description: "Обнулить прогресс студента" },
  { command: "logout", description: "Выйти из аккаунта студента" },
  { command: "rename", description: "Переименовать студента" },
  { command: "delstudent", description: "Удалить студента" },
  { command: "cancel", description: "Отменить действие" },
  { command: "help", description: "Все команды" },
];

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

function send(env, chatId, text, replyMarkup, entities) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(entities ? { entities } : {}),
  });
}

// Выделяет чанк жирным. Спецсимволы в тексте при этом не ломают сообщение.
function boldChunk(chunk, offset = 0) {
  return [{ type: "bold", offset, length: chunk.text.length }];
}

function formatDateTime(env, iso) {
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: env.TIMEZONE || "Europe/Istanbul",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function statsText(env, db) {
  const rows = await db.stats();
  if (!rows.length) return "Студентов пока нет: /addstudent Имя";
  const blocks = rows.map((row) => {
    const status = !row.telegram_id
      ? "не подключён(а)"
      : row.last_seen
        ? `подключён(а), последний вход: ${formatDateTime(env, row.last_seen)}`
        : "подключён(а), ещё не заходил(а)";
    return (
      `${row.name}: ${status}\n` +
      `чанков ${row.chunks} (из них добавлено сами ${row.own_chunks}) · ` +
      `карточек ${row.cards_done} · ответов ${row.answers} · серия ${row.streak} дн.`
    );
  });
  return blocks.join("\n\n").slice(0, 4000);
}

function shuffle(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

function badgesFor(p) {
  const badges = [];
  if (p.chunks >= 1) badges.push("🌱 Первые шаги: первая лексика");
  if (p.own_chunks >= 5) badges.push("✍️ Автор: 5 чанков добавлено самостоятельно");
  if (p.answers >= 10) badges.push("📝 Практик: 10 ответов на задания");
  if (p.cards_done >= 10) badges.push("🃏 Память: 10 карточек пройдено");
  if (p.quiz_correct >= 10) badges.push("🧩 Квиз-мастер: 10 верных ответов");
  if (p.best_streak >= 7) badges.push("🔥 Неделя подряд: 7 дней без перерыва");
  if (p.best_streak >= 30) badges.push("🏆 Месяц подряд: 30 дней");
  return badges;
}

async function progressText(db, student) {
  const p = await db.progressRow(student.id);
  const badges = badgesFor(p);
  return [
    `🔥 Серия: ${p.streak} дн. (рекорд: ${p.best_streak})`,
    `🧩 Квиз: верно ${p.quiz_correct} из ${p.quiz_total}`,
    `🃏 Карточек пройдено: ${p.cards_done}`,
    "",
    "Бейджи:",
    ...(badges.length ? badges.map((badge) => `• ${badge}`) : ["пока нет, но всё впереди! 🚀"]),
  ].join("\n");
}

const PREPOSITIONS = ["to", "on", "in", "at", "for", "of", "with", "about", "from"];

// Предлог в конце чанка, например «look forward to» → «to».
function prepositionOf(text) {
  const words = text.trim().split(/\s+/);
  if (words.length < 2) return null;
  const last = words[words.length - 1].toLowerCase();
  return PREPOSITIONS.includes(last) ? last : null;
}

// Четыре варианта: правильный ответ и три другие из лексики студента.
function textOptions(answer, texts) {
  const others = shuffle(texts.filter((text) => text !== answer)).slice(0, 3);
  return shuffle([answer, ...others]);
}

// Квиз: перевод или предлог, тип и чанк выбираются случайно из подходящих.
async function sendQuiz(env, db, chatId, student, count = 0, progress = { score: 0, mistakes: [] }) {
  const all = await db.chunks(student.id);
  const texts = [...new Set(all.map((chunk) => chunk.text))];
  const pools = {
    translation: all.filter((chunk) => chunk.translation),
    preposition: all.filter((chunk) => prepositionOf(chunk.text)),
  };
  const kinds = Object.keys(pools).filter((kind) => pools[kind].length);
  if (!kinds.length || texts.length < 4) {
    await db.clearState(student.telegram_id);
    await send(
      env,
      chatId,
      "Для квиза нужно минимум 4 разных чанка и хотя бы один с переводом, примером или предлогом в конце. Добавь лексику.",
    );
    return;
  }
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  const chunk = pools[kind][Math.floor(Math.random() * pools[kind].length)];

  let question;
  let answer;
  let options;
  if (kind === "translation") {
    question = `Как сказать по-английски: «${chunk.translation}»?`;
    answer = chunk.text;
    options = textOptions(answer, texts);
  } else {
    const preposition = prepositionOf(chunk.text);
    const base = chunk.text.trim().split(/\s+/).slice(0, -1).join(" ");
    question = `Какой предлог пропущен? «${base} ___»`;
    answer = preposition;
    const others = shuffle(PREPOSITIONS.filter((word) => word !== preposition)).slice(0, 3);
    options = shuffle([preposition, ...others]);
  }

  const result = await telegram(env, "sendPoll", {
    chat_id: chatId,
    question: `${count + 1}/${QUIZ_LENGTH} · ${question}`.slice(0, 300),
    options: options.map((text) => ({ text: text.slice(0, 100) })),
    type: "quiz",
    correct_option_id: options.indexOf(answer),
    is_anonymous: false,
  });
  await db.saveQuiz(result.poll.id, student.id, options.indexOf(answer));
  // Пример покажем сообщением сразу после ответа, поэтому запоминаем его здесь.
  await db.setState(student.telegram_id, {
    quiz: count,
    score: progress.score,
    mistakes: progress.mistakes,
    poll: {
      id: result.poll.id,
      text: chunk.text,
      answer,
      translation: chunk.translation || "",
      example: chunk.example || "",
      options,
    },
  });
}

// Итог квиза: сколько верно и какие чанки студент не выбрал.
function quizSummary(score, mistakes) {
  const title = `🧩 Квиз окончен: верно ${score} из ${QUIZ_LENGTH}.`;
  if (!mistakes.length) {
    return { text: `${title}\n\nБез ошибок! 🎉`, entities: boldChunk({ text: title }) };
  }
  const lines = mistakes.map(
    (m) => `• ${m.text}${m.translation ? ` — ${m.translation}` : ""}\n  Ты выбрала: ${m.chosen}, правильно: ${m.answer}`,
  );
  return {
    text: `${title}\n\nОшибки:\n${lines.join("\n")}`,
    entities: boldChunk({ text: title }),
  };
}

// Сообщение после ответа: верно или нет, и пример с выделенным чанком.
async function sendVerdict(env, chatId, poll, correct) {
  const head = correct ? "✅ Верно!" : `❌ Не совсем. Правильно: ${poll.answer}`;
  const entities = correct ? [] : [{ type: "bold", offset: head.length - poll.answer.length, length: poll.answer.length }];
  let text = head;
  if (poll.example) {
    const label = "\n\nПример: ";
    const at = poll.example.toLowerCase().indexOf(poll.text.toLowerCase());
    if (at >= 0) {
      entities.push({
        type: "bold",
        offset: text.length + label.length + at,
        length: poll.text.length,
      });
    }
    text += label + poll.example;
  }
  return send(env, chatId, text, null, entities.length ? entities : undefined);
}

// Telegram присылает ответ на квиз, мы его засчитываем.
async function onPollAnswer(env, db, answer) {
  const quiz = await db.quizPoll(answer.poll_id);
  if (!quiz || quiz.answered || !answer.option_ids.length) return;
  const student = await db.student(quiz.student_id);
  if (!student || student.telegram_id !== answer.user.id) return;
  const correct = answer.option_ids[0] === quiz.correct_index;
  await db.answerQuiz(answer.poll_id, student.id, correct);

  // Квиз продолжается сам, пока студентка не выйдет из него кнопкой меню.
  const state = await db.getState(student.telegram_id);
  if (typeof state.quiz !== "number") return;
  const progress = { score: state.score || 0, mistakes: state.mistakes || [] };
  if (state.poll && state.poll.id === answer.poll_id) {
    await sendVerdict(env, student.telegram_id, state.poll, correct);
    if (correct) {
      progress.score += 1;
    } else {
      progress.mistakes.push({
        text: state.poll.text,
        translation: state.poll.translation,
        chosen: state.poll.options[answer.option_ids[0]],
        answer: state.poll.answer,
      });
    }
  }
  const answered = state.quiz + 1;
  if (answered >= QUIZ_LENGTH) {
    await db.clearState(student.telegram_id);
    const summary = quizSummary(progress.score, progress.mistakes);
    await send(env, student.telegram_id, summary.text, null, summary.entities);
    return;
  }
  try {
    await sendQuiz(env, db, student.telegram_id, student, answered, progress);
  } catch (error) {
    console.error("Квиз не продолжился", error.message);
    await send(env, student.telegram_id, "Не получилось открыть следующий вопрос. Нажми 🧩 Квиз, чтобы продолжить.");
  }
}

function formatDate(isoDate) {
  return isoDate.split("-").reverse().join(".");
}

function sendNote(env, chatId, note) {
  const title = `📝 Заметка с урока, ${formatDate(note.lesson_date)}`;
  return send(env, chatId, `${title}\n\n${note.text}`, null, boldChunk({ text: title }));
}

// Показывает кнопку «Меню» с командами только в чате Насти.
async function showTeacherMenu(env, chatId) {
  try {
    await telegram(env, "setMyCommands", {
      commands: TEACHER_COMMANDS,
      scope: { type: "chat", chat_id: chatId },
    });
  } catch (error) {
    console.error("Не удалось настроить меню команд", error.message);
  }
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

// Список с галочками: можно выбрать одного, нескольких или всех.
async function addKeyboard(db, selected) {
  const rows = (await db.students()).map((row) => [
    inline(`${selected.includes(row.id) ? "✅" : "⬜️"} ${row.name}`, `addpick:${row.id}`),
  ]);
  rows.push([inline("Всем студентам", "addfor:all")]);
  rows.push([inline("Готово", "adddone")]);
  return { inline_keyboard: rows };
}

// ---------- Команды ----------
async function onCommand(env, db, message, command, argument) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const teacher = isTeacher(env, userId);

  if (command === "start") {
    await db.clearState(userId);
    if (teacher) await showTeacherMenu(env, chatId);
    const student = await db.studentByTelegram(userId);
    if (student) {
      await send(env, chatId, `Привет, ${student.name}! Что потренируем?`, MENU);
    }
    if (teacher) {
      await send(env, chatId, TEACHER_HELP);
    } else if (!student) {
      await send(env, chatId, "Привет! Введи свой ID от Насти.");
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
  if (command === "logout") {
    await db.clearState(userId);
    await db.unlinkStudent(userId);
    await send(env, chatId, "Залогинься снова, чтобы продолжить работу: введи свой ID.", {
      remove_keyboard: true,
    });
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
    if (command === "add") {
      await db.setState(userId, { picking: [] });
      await send(
        env,
        chatId,
        "Кому добавить лексику? Отметь студентов и нажми «Готово».",
        await addKeyboard(db, []),
      );
      return;
    }
    await send(
      env,
      chatId,
      "Чью лексику показать?",
      await studentPicker(db, "listfor", false),
    );
  } else if (command === "dupes") {
    if (!(await db.students()).length) {
      await send(env, chatId, "Студентов пока нет: /addstudent Имя");
      return;
    }
    await send(
      env,
      chatId,
      "Где искать повторы?",
      await studentPicker(db, "dupesfor", false),
    );
  } else if (command === "reset") {
    if (!(await db.students()).length) {
      await send(env, chatId, "Студентов пока нет: /addstudent Имя");
      return;
    }
    await send(
      env,
      chatId,
      "Чей прогресс обнулить?",
      await studentPicker(db, "resetfor", false),
    );
  } else if (command === "rename" || command === "delstudent") {
    if (!(await db.students()).length) {
      await send(env, chatId, "Студентов пока нет: /addstudent Имя");
      return;
    }
    const prefix = command === "rename" ? "renamefor" : "delfor";
    const title = command === "rename" ? "Какого студента переименовать?" : "Какого студента удалить?";
    await send(env, chatId, title, await studentPicker(db, prefix, false));
  } else if (command === "stats") {
    await send(env, chatId, await statsText(env, db));
  } else if (command === "reply") {
    if (!(await db.students()).length) {
      await send(env, chatId, "Студентов пока нет: /addstudent Имя");
      return;
    }
    await send(
      env,
      chatId,
      "Кому написать?",
      await studentPicker(db, "replyto", false),
    );
  } else if (command === "note") {
    if (!(await db.students()).length) {
      await send(env, chatId, "Сначала создай студента: /addstudent Имя");
      return;
    }
    await send(
      env,
      chatId,
      "Кому отправить заметку?",
      await studentPicker(db, "noteto", false),
    );
  } else if (command === "delete") {
    if (!/^\d+(?:[\s,]+\d+)*$/.test(argument)) {
      await send(env, chatId, "Напиши так: /delete 12 15 20. Номера есть в /list");
      return;
    }
    const ids = [...new Set(argument.split(/[\s,]+/).map(Number))];
    const missing = await db.deleteChunks(ids);
    const lines = [`Удалено чанков: ${ids.length - missing.length}.`];
    if (missing.length) lines.push(`Не найдены: ${missing.join(", ")}.`);
    await send(env, chatId, lines.join("\n"));
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
// Сессия карточек: по 10 штук, потом бот спрашивает, практиковать ещё или закончить.
async function sendCard(env, db, chatId, student, number = 1) {
  if (number > CARD_SESSION) {
    await send(
      env,
      chatId,
      `Сессия из ${CARD_SESSION} карточек пройдена 🎉\n\nПрактиковать ещё или закончить?`,
      {
        inline_keyboard: [[inline("🔁 Ещё 10", "cardsmore"), inline("🏁 Закончить", "cardsend")]],
      },
    );
    return;
  }
  const chunk = await db.nextCard(student.id, clock(env).date);
  if (!chunk) {
    await send(env, chatId, "На сегодня карточек нет. Отличная работа! 🎉");
    return;
  }
  const counter = `Карточка ${number} из ${CARD_SESSION}\n\n`;
  const keyboard = { inline_keyboard: [[inline("Показать", `show:${chunk.id}:${number}`)]] };
  // Без перевода карточка всегда показывается на английском.
  if (chunk.translation && Math.random() < 0.5) {
    const title = `${counter}Как сказать по-английски?\n\n`;
    await send(
      env,
      chatId,
      `${title}${chunk.translation}`,
      keyboard,
      boldChunk({ text: chunk.translation }, title.length),
    );
    return;
  }
  await send(env, chatId, `${counter}${chunk.text}`, keyboard, boldChunk(chunk, counter.length));
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
  const allStudents = await db.students();
  const students =
    state.addingFor === "all"
      ? allStudents
      : allStudents.filter((row) => state.addingFor.includes(row.id));
  const today = clock(env).date;
  const showName = students.length > 1;
  const lines = [];
  let added = 0;
  let skipped = 0;
  for (const student of students) {
    const { fresh, duplicates, similar } = compareChunks(
      await db.chunks(student.id),
      rows,
    );
    if (fresh.length) await db.addChunks([student.id], fresh, today);
    added += fresh.length;
    skipped += duplicates.length;
    const owner = showName ? `${student.name}: ` : "";
    for (const text of duplicates) {
      lines.push(`${owner}уже есть «${text}»`);
    }
    for (const { text, match } of similar) {
      lines.push(`${owner}«${text}» похоже на ${similarLabel(match)}`);
    }
  }
  await db.clearState(message.from.id);
  const header = [`Добавлено чанков: ${added}.`];
  if (skipped) header.push(`Пропущено повторов: ${skipped}.`);
  const details = lines.length ? `\n\n${lines.join("\n")}` : "";
  await send(env, message.chat.id, `${header.join("\n")}${details}`.slice(0, 4000));
}

function similarLabel(chunk) {
  return chunk.id ? `№${chunk.id} «${chunk.text}»` : `«${chunk.text}»`;
}

async function saveNote(env, db, message, state) {
  const chatId = message.chat.id;
  const text = message.text.trim();
  if (text.length > MAX_NOTE_LENGTH) {
    await send(env, chatId, "Заметка слишком длинная. Сократи её и пришли снова.");
    return;
  }
  const student = await db.student(state.noteFor);
  await db.clearState(message.from.id);
  if (!student) {
    await send(env, chatId, "Студент не найден.");
    return;
  }
  const lessonDate = clock(env).date;
  await db.addNote(student.id, lessonDate, text);
  if (!student.telegram_id) {
    await send(env, chatId, `Заметка сохранена. ${student.name} увидит её после входа в бота.`);
    return;
  }
  try {
    await sendNote(env, student.telegram_id, { lesson_date: lessonDate, text });
    await send(env, chatId, `Заметка отправлена: ${student.name}.`);
  } catch (error) {
    console.error("Не удалось отправить заметку", error.message);
    await send(env, chatId, `Заметка сохранена, но не доставлена: ${student.name}.`);
  }
}

async function saveReply(env, db, message, state) {
  const chatId = message.chat.id;
  const text = message.text.trim();
  if (text.length > MAX_NOTE_LENGTH) {
    await send(env, chatId, "Сообщение слишком длинное. Сократи его и пришли снова.");
    return;
  }
  const student = await db.student(state.replyTo);
  await db.clearState(message.from.id);
  if (!student || !student.telegram_id) {
    await send(env, chatId, "Этот студент ещё не вошёл в бота, сообщение не отправлено.");
    return;
  }
  try {
    const title = "💬 Сообщение от Насти";
    await send(
      env,
      student.telegram_id,
      `${title}\n\n${text}`,
      null,
      boldChunk({ text: title }),
    );
    await send(env, chatId, `Отправлено: ${student.name}.`);
  } catch (error) {
    console.error("Не удалось отправить сообщение студенту", error.message);
    await send(env, chatId, `Не удалось доставить сообщение: ${student.name}.`);
  }
}

async function saveAnswer(env, db, message, student, state, text) {
  await db.addAnswer(student.id, state.frame, text);
  await db.clearState(message.from.id);
  await send(env, message.chat.id, "Записано! Настя увидит твой ответ. ✅");
  let feedback = null;
  if ((await db.answersLastDay(student.id)) <= MAX_AI_CHECKS_PER_DAY) {
    feedback = await checkAnswer(env, state.frame, text);
  }
  if (feedback) {
    await send(env, message.chat.id, `🤖 Автопроверка\n\n${feedback}`);
  }
  if (env.TEACHER_ID) {
    try {
      const report = `${student.name}\n${state.frame}\n→ ${text}`;
      await send(env, env.TEACHER_ID, feedback ? `${report}\n\n🤖 ${feedback}` : report, {
        inline_keyboard: [[inline("Ответить", `replyto:${student.id}`)]],
      });
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
  const { fresh, duplicates, similar } = compareChunks(await db.chunks(student.id), rows);
  await db.clearState(message.from.id);
  if (fresh.length) {
    await db.addChunks([student.id], fresh, clock(env).date);
    await db.increment(student.id, "own_chunks", fresh.length);
  }
  const reply = [];
  if (fresh.length) {
    reply.push(`Добавлено чанков: ${fresh.length}. Они уже в карточках! ✅`);
  }
  if (duplicates.length) {
    reply.push(`Уже есть, не добавлено: ${duplicates.join(", ")}.`);
  }
  for (const { text, match } of similar) {
    reply.push(`«${text}» похоже на «${match.text}».`);
  }
  await send(env, chatId, reply.join("\n").slice(0, 4000));
  if (!fresh.length) return;
  if (env.TEACHER_ID) {
    try {
      const list = fresh.map((row) => row.filter(Boolean).join(" | ")).join("\n");
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

// Новое имя студента: присылает преподаватель после /rename.
async function saveName(env, db, message, state) {
  const chatId = message.chat.id;
  const name = message.text.trim();
  if (!name || name.length > 50) {
    await send(env, chatId, "Имя должно быть от 1 до 50 символов. Пришли ещё раз.");
    return;
  }
  const student = await db.student(state.renaming);
  await db.clearState(message.from.id);
  if (!student) {
    await send(env, chatId, "Студент не найден.");
    return;
  }
  await db.renameStudent(student.id, name);
  await send(env, chatId, `Готово: «${student.name}» → «${name}».`);
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
  if (isTeacher(env, userId) && state.replyTo !== undefined) {
    await saveReply(env, db, message, state);
    return;
  }
  if (isTeacher(env, userId) && state.noteFor !== undefined) {
    await saveNote(env, db, message, state);
    return;
  }
  if (isTeacher(env, userId) && state.renaming !== undefined) {
    await saveName(env, db, message, state);
    return;
  }

  const student = await db.studentByTelegram(userId);
  if (!student) {
    const name = await db.linkStudent(text, userId);
    if (name) {
      await send(env, chatId, welcome(name), MENU);
    } else {
      await send(env, chatId, "Такого ID нет. Проверь его или спроси Настю.");
    }
    return;
  }

  await db.touch(student.id, new Date().toISOString(), clock(env).date);

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
  } else if (text === NOTES) {
    await db.clearState(userId);
    const notes = await db.notes(student.id);
    if (!notes.length) {
      await send(env, chatId, "Заметок пока нет.");
      return;
    }
    await send(env, chatId, "Выбери заметку:", {
      inline_keyboard: notes.map((note) => {
        const preview = note.text.replace(/\s+/g, " ").slice(0, 24);
        return [inline(`${formatDate(note.lesson_date)} · ${preview}`, `note:${note.id}`)];
      }),
    });
  } else if (text === QUIZ) {
    await db.clearState(userId);
    await send(env, chatId, "Квиз из 10 вопросов запущен. Чтобы остановиться раньше, нажми любую кнопку меню.");
    await sendQuiz(env, db, chatId, student);
  } else if (text === PROGRESS) {
    await db.clearState(userId);
    await send(env, chatId, await progressText(db, student));
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
  const [action, value, extra] = query.data.split(":");
  const id = Number(value);

  if (action === "dupesfor") {
    if (!isTeacher(env, userId)) return;
    // Сравнение всех пар затратно, а бесплатный тариф ограничивает время CPU.
    const pairs = findDuplicatePairs((await db.chunks(id)).slice(0, MAX_DUPES_CHECK));
    const lines = pairs.map(
      ([first, second]) => `№${first.id} «${first.text}» ≈ №${second.id} «${second.text}»`,
    );
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: lines.length
        ? `${lines.join("\n")}\n\nЛишнее можно удалить: /delete номер`.slice(0, 4000)
        : "Повторов не найдено.",
    });
    return;
  }

  if (action === "resetfor" || action === "resetyes") {
    if (!isTeacher(env, userId)) return;
    const student = await db.student(id);
    if (!student) return;
    if (action === "resetfor") {
      await telegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text:
          `Обнулить прогресс: ${student.name}?\n\n` +
          "Сбросятся повторения карточек, ответы и настройки уведомлений. " +
          "Лексика и заметки останутся.",
        reply_markup: {
          inline_keyboard: [[inline("Да, обнулить", `resetyes:${student.id}`)]],
        },
      });
      return;
    }
    await db.resetProgress(student.id, clock(env).date);
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `Прогресс обнулён: ${student.name}.`,
    });
    return;
  }

  if (action === "cardsmore" || action === "cardsend") {
    const student = await db.studentByTelegram(userId);
    if (!student) return;
    await telegram(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId });
    if (action === "cardsend") {
      await send(env, chatId, "Отличная работа! Закончили на сегодня 🎉");
      return;
    }
    await sendCard(env, db, chatId, student, 1);
    return;
  }

  if (action === "renamefor" || action === "delfor" || action === "delyes") {
    if (!isTeacher(env, userId)) return;
    const student = await db.student(id);
    if (!student) return;
    if (action === "renamefor") {
      await db.setState(userId, { renaming: student.id });
      await telegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `Пришли новое имя для студента «${student.name}».`,
      });
      return;
    }
    if (action === "delfor") {
      await telegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text:
          `Удалить студента «${student.name}»?\n\n` +
          "Удалятся лексика, ответы, заметки и прогресс. Это нельзя отменить.",
        reply_markup: {
          inline_keyboard: [[inline("Да, удалить", `delyes:${student.id}`)]],
        },
      });
      return;
    }
    await db.deleteStudent(student.id);
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `Студент «${student.name}» удалён.`,
    });
    return;
  }

  if (action === "replyto") {
    if (!isTeacher(env, userId)) return;
    const student = await db.student(id);
    if (!student) return;
    await db.setState(userId, { replyTo: student.id });
    await send(env, chatId, `Напиши сообщение для: ${student.name}. /cancel — отмена.`);
    return;
  }

  if (action === "noteto") {
    if (!isTeacher(env, userId)) return;
    const student = await db.student(id);
    if (!student) return;
    await db.setState(userId, { noteFor: student.id });
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `Пришли заметку для: ${student.name}. /cancel — отмена.`,
    });
    return;
  }

  if (action === "addpick" || action === "adddone") {
    if (!isTeacher(env, userId)) return;
    const state = await db.getState(userId);
    const picking = state.picking || [];
    if (action === "addpick") {
      const selected = picking.includes(id)
        ? picking.filter((item) => item !== id)
        : [...picking, id];
      await db.setState(userId, { picking: selected });
      await telegram(env, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: await addKeyboard(db, selected),
      });
      return;
    }
    if (!picking.length) {
      await send(env, chatId, "Сначала отметь хотя бы одного студента.");
      return;
    }
    await db.setState(userId, { addingFor: picking });
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: ADD_FORMAT,
    });
    return;
  }

  if (action === "addfor" || action === "listfor") {
    if (!isTeacher(env, userId)) return;
    if (action === "addfor") {
      await db.setState(userId, { addingFor: value === "all" ? "all" : [id] });
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

  await db.touch(student.id, new Date().toISOString(), clock(env).date);

  if (action === "show") {
    const chunk = await db.chunk(id, student.id);
    if (chunk) {
      const number = Number(extra) || 0;
      const counter = number ? `Карточка ${number} из ${CARD_SESSION}\n\n` : "";
      await telegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `${counter}${cardDetails(chunk)}`,
        entities: boldChunk(chunk, counter.length),
        reply_markup: {
          inline_keyboard: [
            [
              inline("🔁 Повторить", `again:${id}:${number}`),
              inline("✅ Знаю", `know:${id}:${number}`),
            ],
          ],
        },
      });
    }
  } else if (action === "know" || action === "again") {
    await db.review(id, student.id, action === "know", clock(env).date);
    await db.increment(student.id, "cards_done");
    await telegram(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
    });
    await sendCard(env, db, chatId, student, (Number(extra) || 0) + 1);
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
  } else if (action === "note") {
    const note = await db.note(id, student.id);
    if (note) await sendNote(env, chatId, note);
  } else if (action === "frame") {
    const chunk = await db.chunk(id, student.id);
    if (chunk && chunk.frame) {
      await askFrame(env, db, chatId, userId, chunk);
    }
  }
}

async function onUpdate(env, db, update) {
  if (update.poll_answer) {
    await onPollAnswer(env, db, update.poll_answer);
    return;
  }
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
          const title = "Чанк дня ✨\n\n";
          const streak = await db.currentStreak(student.id, date);
          // Чанк остаётся главным, а строка про серию ненавязчивая и обычным шрифтом.
          const friendly = streak
            ? `🔥 Серия: ${streak} дн. подряд. Продолжим?`
            : "🏁 Начни свой марафон: сегодня первый день!";
          await send(
            env,
            chatId,
            `${title}${cardDetails(chunk)}\n\n${friendly}`,
            null,
            boldChunk(chunk, title.length),
          );
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
      allowed_updates: ["message", "callback_query", "poll_answer"],
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
