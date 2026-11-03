// Telegram-бот для отработки чанков на Cloudflare Workers.
// Настройка описана в README.md.
import { Database } from "./db.js";
import { checkAnswer } from "./feedback.js";
import { compareChunks, findDuplicatePairs } from "./similar.js";
import { makeQuestions } from "./tasks.js";
import { rememberTerms } from "./terms.js";
import { fillFrames } from "./frames.js";
import {
  DAY_NAMES,
  REMIND_BEFORE,
  dueReminders,
  inReminderWindow,
  lessonLabel,
  parseMove,
  parseSchedule,
  upcomingOccurrences,
} from "./lessons.js";

const TERMS_RUN_LIMIT = 60;

const CARDS = "🃏 Карточки";
const FRAMES = "✍️ Закончи фразу";
const LESSONS_TAB = "📅 Занятия";
const NOTIFICATIONS = "🔔 Уведомления";
const ADD_CHUNK = "➕ Добавить чанк";
const NOTES = "📝 Заметки";
const QUIZ = "🧩 Квиз";
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
// Задание «Продолжи фразу»: инструкция и пример курсивом, сама фраза жирным.
function frameTask(frame, prefix = "") {
  const intro =
    "Продолжи фразу. Это может быть про тебя, твоё мнение или логическое продолжение.\n\nПример:\n";
  const example =
    "ты видишь: I used to...\nты продолжаешь: I used to live in a small town.";
  const entities = [];
  let text = prefix;
  text += intro;
  entities.push({ type: "italic", offset: text.length, length: example.length });
  text += example;
  text += "\n\n";
  entities.push({ type: "bold", offset: text.length, length: frame.length });
  text += frame;
  return { text, entities };
}

const MENU = {
  keyboard: [
    [{ text: CARDS }, { text: FRAMES }],
    [{ text: QUIZ }, { text: NOTES }],
    [{ text: NOTIFICATIONS }, { text: LESSONS_TAB }],
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
  "/terms — определить термины для кнопок произношения у старой лексики\n" +
  "/frames — написать начала фраз для заданий «Закончи фразу»\n" +
  "/frames redo — пересоздать начала, которые написал Claude\n" +
  "/preview — посмотреть задания любого студента, как их видит студентка\n" +
  "/schedule — расписание уроков студента: день и время\n" +
  "/pay — добавить оплаченные занятия студенту\n" +
  "/profile — профиль студента: баланс, абонементы, статистика уроков\n" +
  "/lesson — отменить или перенести ближайший урок\n" +
  "/frames all — сбросить все начала и создать заново\n" +
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
  { command: "terms", description: "Определить термины для старой лексики" },
  { command: "frames", description: "Написать начала фраз для заданий" },
  { command: "preview", description: "Посмотреть задания студента" },
  { command: "schedule", description: "Расписание уроков студента" },
  { command: "pay", description: "Добавить оплаченные занятия" },
  { command: "profile", description: "Профиль студента: баланс и уроки" },
  { command: "lesson", description: "Отменить или перенести урок" },
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

// Короткий прогресс: вкладка «Занятия» показывает его первым.
async function progressText(db, student) {
  const p = await db.progressRow(student.id);
  const badges = badgesFor(p);
  return [
    `🔥 Серия: ${p.streak} дн. (рекорд: ${p.best_streak})`,
    `🧩 Квиз: верно ${p.quiz_correct} из ${p.quiz_total}`,
    `🃏 Карточек пройдено: ${p.cards_done}`,
    badges.length ? `🏅 Бейджи: ${badges.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
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

const SIMPLE_WORDS = new Set(
  ("a an the to of in on at for with by from into onto about over up out off be is am are was " +
    "were been being have has had do does did get got make made take took my your his her its " +
    "our their it one me him them us i you he she we they this that these those and or but not " +
    "no so as if than then there here").split(" "),
);

const PARTICLES = new Set([
  "up", "out", "off", "on", "in", "away", "back", "over", "down", "through", "around",
  "along", "about", "apart", "by", "forward", "ahead", "into", "together", "round",
]);

// Что искать в словаре. Автоматически не отличить идиому от обычной фразы,
// поэтому для длинных фраз даём два варианта, и студентка выбирает сама.
// фразовый глагол → «weed out» (глагол + частица);
// коллокация → ключевое слово: «wry smile» → wry, «play havoc with» → havoc;
// 4+ слов → ключевое слово и вся фраза (вдруг это идиома).
function dictionaryTerms(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2 && PARTICLES.has(words[1]) && !SIMPLE_WORDS.has(words[0])) {
    return [`${words[0]} ${words[1]}`];
  }
  const content = words.filter((word) => !SIMPLE_WORDS.has(word));
  const longest = [...content].sort((a, b) => b.length - a.length)[0];
  // В двусловных парах первое слово обычно важнее: «wry smile» → wry.
  const keyword = (words.length === 2 ? content[0] : longest) || words.join(" ");
  if (words.length >= 4) return [keyword, words.join(" ")];
  return [keyword];
}

// Ряд кнопок произношения: термины в словаре и, если есть, фраза в YouGlish.
// terms — результат Claude, сохранённый при добавлении чанка; без него правило выше.
function pronunciationRow(text, terms) {
  const row = (terms || dictionaryTerms(text)).map((term) => ({
    text: `🔊 ${term}`,
    url: dictionaryUrl(term),
  }));
  const video = youglishUrl(text);
  if (video) row.push({ text: "🎬 Фраза", url: video });
  return row;
}

// Словарь Cambridge: слово, фразовый глагол или идиома.
function dictionaryUrl(term) {
  const slug = term.replace(/'/g, "").trim().replace(/\s+/g, "-");
  return `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(slug)}`;
}

// Фразы со слотами (one's, someone, sb) в YouGlish почти не находятся, для них ссылки нет.
const PLACEHOLDER = /\b(one'?s|oneself|someone|somebody|sb|sth|something)\b/i;

// YouGlish по всей фразе: произношение и примеры из видео. Или null, если фразы там обычно нет.
function youglishUrl(phrase) {
  if (PLACEHOLDER.test(phrase)) return null;
  // «be rooted in» в видео звучит как «is rooted in», поэтому такой поиск бесполезен.
  if (/^(to\s+)?be\s/i.test(phrase.trim())) return null;
  const clean = phrase.toLowerCase().replace(/[^a-z\s'-]/g, "").trim();
  return `https://youglish.com/pronounce/${encodeURIComponent(clean)}/english`;
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

  // Меню команд обновляется при каждой команде Насти, чтобы новые команды появлялись сами.
  if (teacher) await showTeacherMenu(env, chatId);

  if (command === "start") {
    await db.clearState(userId);
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
  } else if (command === "lesson") {
    if (!(await db.students()).length) {
      await send(env, chatId, "Студентов пока нет: /addstudent Имя");
      return;
    }
    await send(env, chatId, "Чей урок?", await studentPicker(db, "lessonfor", false));
  } else if (command === "schedule" || command === "pay" || command === "profile") {
    if (!(await db.students()).length) {
      await send(env, chatId, "Студентов пока нет: /addstudent Имя");
      return;
    }
    const prefix = { schedule: "schedfor", pay: "payfor", profile: "profilefor" }[command];
    const title = {
      schedule: "Чьё расписание?",
      pay: "Кому добавить занятия?",
      profile: "Чей профиль посмотреть?",
    }[command];
    await send(env, chatId, title, await studentPicker(db, prefix, false));
  } else if (command === "preview") {
    if (!(await db.students()).length) {
      await send(env, chatId, "Студентов пока нет: /addstudent Имя");
      return;
    }
    await send(env, chatId, "Чьи задания посмотреть?", await studentPicker(db, "previewfor", false));
  } else if (command === "frames") {
    if (!env.ANTHROPIC_API_KEY) {
      await send(env, chatId, "Без ключа ANTHROPIC_API_KEY начала фраз не создаются.");
      return;
    }
    try {
      if (argument === "all") {
        // Полная перегенерация: сбрасываются и начала, написанные вручную.
        await db.clearAllFrames();
      } else if (argument === "redo") {
        // Пересоздаём только начала, которые написал Claude: начала студенток и преподавательницы не трогаем.
        await db.clearGeneratedFrames();
      }
      const rows = await db.framelessTexts();
      if (!rows.length) {
        await send(env, chatId, "У всех чанков есть начало фразы ✅");
        return;
      }
      await send(env, chatId, `Пишу начала фраз для ${Math.min(rows.length, TERMS_RUN_LIMIT)} чанков, это может занять минуту…`);
      await fillFrames(env, db, rows.slice(0, TERMS_RUN_LIMIT));
      const left = (await db.framelessTexts()).length;
      await send(
        env,
        chatId,
        left
          ? `Осталось без начала фразы: ${left}. Запусти /frames ещё раз.`
          : "Готово: у всех чанков есть начало фразы ✅",
      );
    } catch (error) {
      console.error("/frames не сработал", error.message);
      await send(env, chatId, `Не получилось написать начала фраз: ${error.message}`);
    }
  } else if (command === "terms") {
    if (!env.ANTHROPIC_API_KEY) {
      await send(env, chatId, "Без ключа ANTHROPIC_API_KEY термины не определяются.");
      return;
    }
    try {
      const texts = await db.chunkTexts();
      const known = await db.knownPhrases();
      const pending = texts.filter((text) => !known.has(text.trim().toLowerCase()));
      if (!pending.length) {
        await send(env, chatId, "Все чанки уже классифицированы ✅");
        return;
      }
      await send(env, chatId, `Определяю термины для ${Math.min(pending.length, TERMS_RUN_LIMIT)} фраз, это может занять минуту…`);
      // Один запуск ограничен, чтобы уложиться в лимиты Cloudflare и не ждать слишком долго.
      const done = await rememberTerms(env, db, pending.slice(0, TERMS_RUN_LIMIT));
      const left = pending.length - done;
      await send(
        env,
        chatId,
        left
          ? `Классифицировано: ${done}. Осталось: ${left}. Запусти /terms ещё раз.`
          : `Классифицировано: ${done}. Готово ✅`,
      );
    } catch (error) {
      console.error("/terms не сработал", error.message);
      await send(env, chatId, `Не получилось определить термины: ${error.message}`);
    }
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
const SESSION_END_TEXT = `Сессия из ${CARD_SESSION} карточек пройдена 🎉\n\nПрактиковать ещё или закончить?`;

function sessionEndKeyboard() {
  return {
    inline_keyboard: [
      [inline("🗣 Попробовать эти карточки в речи", "task")],
      [inline("🔁 Ещё 10", "cardsmore"), inline("🏁 Закончить", "cardsend")],
    ],
  };
}

async function sendCard(env, db, chatId, student, number = 1) {
  if (number > CARD_SESSION) {
    await send(env, chatId, SESSION_END_TEXT, sessionEndKeyboard());
    return;
  }
  const chunk = await db.nextCard(student.id, clock(env).date);
  if (!chunk) {
    await send(env, chatId, "На сегодня карточек нет. Отличная работа! 🎉");
    return;
  }
  // Запоминаем чанки сессии: по ним потом строится задание.
  const session = await db.getState(student.telegram_id);
  const ids = number === 1 ? [] : session.session || [];
  await db.setState(student.telegram_id, { ...session, session: [...ids, chunk.id] });

  const counter = `${number}/${CARD_SESSION}\n\n`;
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
  const task = frameTask(chunk.frame);
  await send(
    env,
    chatId,
    task.text,
    { inline_keyboard: [[inline("➡️ Следующая фраза", "nextframe")]] },
    task.entities,
  );
}

// Следующая случайная фраза с заданием; false, если заданий больше нет.
async function askNextFrame(env, db, chatId, userId, studentId) {
  const chunk = await db.randomFrame(studentId);
  if (!chunk) return false;
  await askFrame(env, db, chatId, userId, chunk);
  return true;
}

async function saveSchedule(env, db, message, state) {
  const chatId = message.chat.id;
  const text = message.text.trim();
  const target = await db.student(state.scheduleFor);
  if (!target) {
    await db.clearState(message.from.id);
    return;
  }
  if (text === "-") {
    await db.setSchedule(target.id, []);
    await db.clearState(message.from.id);
    await send(env, chatId, `Расписание ${target.name} очищено.`);
    return;
  }
  const slots = parseSchedule(text);
  if (!slots) {
    await send(env, chatId, "Не поняла. Пиши так: вт 16:00, пт 16:00");
    return;
  }
  await db.setSchedule(target.id, slots);
  await db.clearState(message.from.id);
  const list = slots.map((slot) => `${DAY_NAMES[slot.weekday]} ${slot.time}`).join(", ");
  await send(env, chatId, `Расписание ${target.name}: ${list}.`);
}

async function savePayment(env, db, message, state) {
  const chatId = message.chat.id;
  const target = await db.student(state.payFor);
  const count = Number(message.text.trim().replace(/^\+/, ""));
  if (!target) {
    await db.clearState(message.from.id);
    return;
  }
  if (!Number.isInteger(count) || count <= 0) {
    await send(env, chatId, "Напиши число занятий, например: 8");
    return;
  }
  await db.clearState(message.from.id);
  const balance = await db.addPaid(target.id, count, clock(env).date);
  await send(env, chatId, `Добавлено ${count}. Баланс ${target.name}: ${balance}.`);
}

const STATUS_LABELS = { held: "проведено", cancelled: "отменено", moved: "перенесено" };

// Ближайшие уроки на 2 недели, с перенесёнными и без уже отмеченных.
async function upcomingLessons(env, db, studentId, limit = 10) {
  const today = clock(env).date;
  const taken = new Set(
    (await db.lessonsFrom(studentId, today)).map((row) => `${row.lesson_date} ${row.lesson_time}`),
  );
  const planned = (await db.plannedFrom(studentId, today)).map((row) => ({
    date: row.lesson_date,
    time: row.lesson_time,
  }));
  return [...upcomingOccurrences(await db.schedule(studentId), today, 14), ...planned]
    .filter((item) => !taken.has(`${item.date} ${item.time}`))
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
    .slice(0, limit);
}

// Профиль для преподавательницы.
async function profileText(db, student) {
  const balance = await db.balance(student.id);
  const report = await db.subscriptionsReport(student.id);
  const counts = await db.statusCounts(student.id);
  const slots = (await db.schedule(student.id))
    .map((slot) => `${DAY_NAMES[slot.weekday]} ${slot.time}`)
    .join(", ");
  const current = report.current
    ? `Текущий абонемент: использовано ${report.current.used} из ${report.current.paid}`
    : "Текущего абонемента нет";
  const closed = report.closed
    .map((sub, index) => `Абонемент ${index + 1}: посещено ${sub.paid} из ${sub.paid}`)
    .join("\n");
  const history = (await db.lessonHistory(student.id, 10))
    .map((row) => `${lessonLabel(row.lesson_date, row.lesson_time)}: ${STATUS_LABELS[row.status]}${row.charged ? " (списано)" : ""}`)
    .join("\n");
  return [
    student.name,
    `Баланс: ${balance}`,
    current,
    closed || null,
    `Проведено: ${counts.held || 0}, отменено: ${counts.cancelled || 0}, перенесено: ${counts.moved || 0}`,
    `Расписание: ${slots || "нет"}`,
    `Последние уроки:\n${history || "пока нет"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Текст, когда занятия на абонементе закончились.
export async function zeroBalanceText(db, studentId) {
  const report = await db.subscriptionsReport(studentId);
  const last = report.closed.at(-1);
  const finished = last ? `В прошлом абонементе посещено ${last.paid} из ${last.paid}. Так держать! ` : "";
  return `Занятия на абонементе закончились. ${finished}После оплаты напиши Насте или сюда :)`;
}

// Вкладка «Занятия» для студентки.
async function studentLessonsText(env, db, student) {
  const progress = await progressText(db, student);
  const balance = await db.balance(student.id);
  const slots = (await db.schedule(student.id))
    .map((slot) => `${DAY_NAMES[slot.weekday]} ${slot.time}`)
    .join(", ");
  const upcoming = (await upcomingLessons(env, db, student.id, 3))
    .map((item) => lessonLabel(item.date, item.time))
    .join("\n");
  const history = (await db.lessonHistory(student.id, 5))
    .map((row) => `${lessonLabel(row.lesson_date, row.lesson_time)}: ${STATUS_LABELS[row.status]}`)
    .join("\n");
  return [
    progress,
    `Оплаченных занятий осталось: ${balance}`,
    `Расписание: ${slots || "нет"}`,
    `Ближайшие уроки:\n${upcoming || "нет"}`,
    `Последние уроки:\n${history || "пока нет"}`,
  ].join("\n\n");
}

async function saveMove(env, db, message, state) {
  const chatId = message.chat.id;
  const { studentId, date, time } = state.moveFor;
  const target = await db.student(studentId);
  if (!target) {
    await db.clearState(message.from.id);
    return;
  }
  const next = parseMove(message.text, clock(env).date.slice(0, 4));
  if (!next) {
    await send(env, chatId, "Не поняла. Пиши так: 05.11 18:00");
    return;
  }
  await db.clearState(message.from.id);
  await db.markLesson(studentId, date, time, "moved");
  await db.claimReminder(studentId, date, time);
  await db.addPlanned(studentId, next.date, next.time);
  await send(
    env,
    chatId,
    `${target.name}: ${lessonLabel(date, time)} перенесён на ${lessonLabel(next.date, next.time)}. Напомню перед уроком.`,
  );
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
    if (fresh.length) {
      await db.addChunks([student.id], fresh, today);
      await rememberTerms(env, db, fresh.map((row) => row[0]));
      await fillFrames(env, db, fresh.filter((row) => !row[3]).map(([text, translation, example]) => ({ text, translation, example })));
    }
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
  let feedback = null;
  if ((await db.answersLastDay(student.id)) <= MAX_AI_CHECKS_PER_DAY) {
    feedback = await checkAnswer(env, state.frame, text);
  }
  if (feedback) {
    await send(env, message.chat.id, `🤖 Автопроверка\n\n${feedback}`);
  }
  await askNextFrame(env, db, message.chat.id, message.from.id, student.id);
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
  const parsed = parseChunks(text);
  // Чанк должен содержать английские буквы: «да» или «ок» в лексику не попадают.
  const rows = parsed.filter((row) => /[a-z]/i.test(row[0]));
  const skipped = parsed.filter((row) => !/[a-z]/i.test(row[0])).map((row) => row[0]);
  if (skipped.length) {
    await send(env, chatId, `Не добавила, это не английский чанк: ${skipped.join(", ")}.`);
  }
  if (!rows.length) {
    if (!skipped.length) await send(env, chatId, STUDENT_ADD_FORMAT);
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
    await rememberTerms(env, db, fresh.map((row) => row[0]));
    await fillFrames(env, db, fresh.filter((row) => !row[3]).map(([text, translation, example]) => ({ text, translation, example })));
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

  if (isTeacher(env, userId) && state.scheduleFor !== undefined) {
    await saveSchedule(env, db, message, state);
    return;
  }
  if (isTeacher(env, userId) && state.moveFor !== undefined) {
    await saveMove(env, db, message, state);
    return;
  }
  if (isTeacher(env, userId) && state.payFor !== undefined) {
    await savePayment(env, db, message, state);
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
  } else if (text === LESSONS_TAB) {
    await db.clearState(userId);
    await send(env, chatId, await studentLessonsText(env, db, student), MENU);
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
  } else if (text === ADD_CHUNK) {
    await db.setState(userId, { awaiting: "chunk" });
    await send(env, chatId, STUDENT_ADD_FORMAT);
  } else if (state.awaiting === "chunk") {
    await saveStudentChunks(env, db, message, student, text);
  } else if (state.awaiting === "frame") {
    await saveAnswer(env, db, message, student, state, text);
  } else if (state.awaiting === "task") {
    await saveTask(env, db, message, student, state, text);
  } else if (state.awaiting === "time") {
    await saveTime(env, db, message, student, text);
  } else {
    await send(env, chatId, "Выбирай в меню, чем сегодня займёшься 👇", MENU);
  }
}

// Ответ на задание после карточек уходит Насте на проверку.
async function sendTaskToTeacher(env, student, task, answer) {
  if (!env.TEACHER_ID) return;
  const questions = task.questions ? `${task.questions.join("\n")}\n\n` : "";
  const report = `📝 Задание: ${student.name}\n${questions}Чанки: ${task.chunks.join(", ")}\n\n→ ${answer}`;
  await send(env, env.TEACHER_ID, report.slice(0, 4000), {
    inline_keyboard: [[inline("Ответить", `replyto:${student.id}`)]],
  });
}

async function saveTask(env, db, message, student, state, text) {
  const { awaiting, task, ...rest } = state;
  await db.setState(message.from.id, rest);
  await sendTaskToTeacher(env, student, task, text);
  await send(env, message.chat.id, "Отправлено Насте на проверку ✅");
}

// Голосовой ответ на задание пересылаем Насте как есть.
async function onVoice(env, db, message) {
  const userId = message.from.id;
  const student = await db.studentByTelegram(userId);
  if (!student) return;
  const state = await db.getState(userId);
  if (state.awaiting !== "task") {
    await send(env, message.chat.id, "Голосовые принимаю только в задании 📝");
    return;
  }
  const { awaiting, task, ...rest } = state;
  await db.setState(userId, rest);
  await sendTaskToTeacher(env, student, task, "🎤 голосовой ответ ниже");
  if (env.TEACHER_ID) {
    await telegram(env, "forwardMessage", {
      chat_id: env.TEACHER_ID,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
  }
  await send(env, message.chat.id, "Отправлено Насте на проверку ✅");
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

  // Ближайшие уроки студентки: выбрать один из них.
  if (action === "lessonfor") {
    if (!isTeacher(env, userId)) return;
    const target = await db.student(id);
    if (!target) return;
    const today = clock(env).date;
    const taken = new Set(
      (await db.lessonsFrom(target.id, today)).map((row) => `${row.lesson_date} ${row.lesson_time}`),
    );
    const planned = (await db.plannedFrom(target.id, today)).map((row) => ({
      date: row.lesson_date,
      time: row.lesson_time,
    }));
    const upcoming = [...upcomingOccurrences(await db.schedule(target.id), today, 14), ...planned]
      .filter((item) => !taken.has(`${item.date} ${item.time}`))
      .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
      .slice(0, 10);
    if (!upcoming.length) {
      await send(env, chatId, `У ${target.name} нет ближайших уроков.`);
      return;
    }
    await send(env, chatId, `Какой урок у ${target.name}?`, {
      inline_keyboard: upcoming.map((item) => [
        inline(lessonLabel(item.date, item.time), `lessonpick:${target.id}:${item.date}:${item.time.replace(":", "")}`),
      ]),
    });
    return;
  }

  // Что сделать с выбранным уроком: отменить или перенести.
  if (action === "lessonpick") {
    if (!isTeacher(env, userId)) return;
    const [, studentText, date, compact] = query.data.split(":");
    const target = await db.student(Number(studentText));
    if (!target) return;
    const time = `${compact.slice(0, 2)}:${compact.slice(2)}`;
    const data = `${target.id}:${date}:${compact}`;
    await send(env, chatId, `${target.name}, ${lessonLabel(date, time)}. Что сделать?`, {
      inline_keyboard: [
        [inline("❌ Отменить урок", `lessonskip:${data}`)],
        [inline("🔁 Перенести", `lessonmove:${data}`)],
      ],
    });
    return;
  }

  // Отмена заранее: урок не списывается и напоминания по нему не будет.
  if (action === "lessonskip") {
    if (!isTeacher(env, userId)) return;
    const [, studentText, date, compact] = query.data.split(":");
    const target = await db.student(Number(studentText));
    if (!target) return;
    const time = `${compact.slice(0, 2)}:${compact.slice(2)}`;
    await db.markLesson(target.id, date, time, "cancelled");
    await db.claimReminder(target.id, date, time);
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `${target.name}, ${lessonLabel(date, time)}: отменено. Не списано.`,
    });
    return;
  }

  // Перенос: спрашиваем новую дату и время. Старый урок отмечается, когда новая дата введена.
  if (action === "lessonmove") {
    if (!isTeacher(env, userId)) return;
    const [, studentText, date, compact] = query.data.split(":");
    const target = await db.student(Number(studentText));
    if (!target) return;
    const time = `${compact.slice(0, 2)}:${compact.slice(2)}`;
    await db.setState(userId, { moveFor: { studentId: target.id, date, time } });
    await send(
      env,
      chatId,
      `Перенос ${target.name} с ${lessonLabel(date, time)}. На какую дату и время? Например: 05.11 18:00`,
    );
    return;
  }

  // Напоминание об уроке: отметить проведён, отменён или перенесён.
  if (action === "lessonyes" || action === "lessonno") {
    if (!isTeacher(env, userId)) return;
    const [, studentText, date, compact] = query.data.split(":");
    const target = await db.student(Number(studentText));
    if (!target) return;
    const time = `${compact.slice(0, 2)}:${compact.slice(2)}`;
    const status = { lessonyes: "held", lessonno: "cancelled" }[action];
    const result = await db.markLesson(target.id, date, time, status);
    const label = { held: "проведено", cancelled: "отменено", moved: "перенесено" }[status];
    let charge = "Не списано.";
    if (status === "held") {
      charge = result.charged ? `Списано, осталось: ${result.balance}.` : "Не списано: баланс пуст.";
    }
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `${target.name}, ${date} ${time}: ${label}. ${charge}`,
    });
    if (result.charged && result.balance === 0 && target.telegram_id) {
      try {
        await send(env, target.telegram_id, await zeroBalanceText(db, target.id));
      } catch (error) {
        console.error("Не удалось написать студенту про оплату", error.message);
      }
    }
    return;
  }

  if (action === "schedfor" || action === "payfor" || action === "profilefor") {
    if (!isTeacher(env, userId)) return;
    const target = await db.student(id);
    if (!target) return;
    if (action === "schedfor") {
      await db.setState(userId, { scheduleFor: target.id });
      const current = (await db.schedule(target.id))
        .map((slot) => `${DAY_NAMES[slot.weekday]} ${slot.time}`)
        .join(", ");
      await send(
        env,
        chatId,
        `Расписание ${target.name} сейчас: ${current || "нет"}.\nНапиши новое, например: вт 16:00, пт 16:00. Чтобы очистить, напиши «-».`,
      );
    } else if (action === "payfor") {
      await db.setState(userId, { payFor: target.id });
      await send(env, chatId, `Сколько занятий добавить ${target.name}? Например: 8`);
    } else {
      await send(env, chatId, await profileText(db, target));
    }
    return;
  }

  // Просмотр глазами студента: учительница выбирает, что показать.
  if (action === "previewfor") {
    if (!isTeacher(env, userId)) return;
    const target = await db.student(id);
    if (!target) return;
    await send(env, chatId, `Что показать у ученика ${target.name}?`, {
      inline_keyboard: [
        [inline("✍️ Закончи фразу", `previewframe:${target.id}`)],
        [inline("🃏 Карточка", `previewcard:${target.id}`)],
        [inline("🗣 Задание после карточек", `previewtask:${target.id}`)],
      ],
    });
    return;
  }

  if (action === "previewframe" || action === "previewcard" || action === "previewtask") {
    if (!isTeacher(env, userId)) return;
    const target = await db.student(id);
    if (!target) return;
    const next = { inline_keyboard: [[inline("➡️ Другая", `${action}:${target.id}`)]] };
    const head = `Как видит ученик ${target.name}:\n\n`;
    if (action === "previewframe") {
      const chunk = await db.randomFrame(target.id);
      if (!chunk) {
        await send(env, chatId, `У ученика ${target.name} пока нет заданий «Закончи фразу».`);
        return;
      }
      const task = frameTask(chunk.frame, head);
      await send(env, chatId, task.text, next, task.entities);
      return;
    }
    if (action === "previewcard") {
      const chunks = await db.chunks(target.id);
      if (!chunks.length) {
        await send(env, chatId, `У ученика ${target.name} пока нет чанков.`);
        return;
      }
      const chunk = chunks[Math.floor(Math.random() * chunks.length)];
      // Как в карточках: иногда перевод, иногда английский. Прогресс не меняется.
      const front =
        chunk.translation && Math.random() < 0.5
          ? `Как сказать по-английски?\n\n${chunk.translation}`
          : chunk.text;
      await send(env, chatId, `${head}${front}`, next);
      return;
    }
    // Задание после карточек: 5 случайных чанков, как в настоящем задании.
    const chunks = (await db.chunks(target.id)).map((row) => row.text);
    const picked = chunks.sort(() => Math.random() - 0.5).slice(0, 5);
    if (!picked.length) {
      await send(env, chatId, `У ученика ${target.name} пока нет чанков.`);
      return;
    }
    const questions = await makeQuestions(env, picked);
    const intro = questions
      ? `Ответь на вопросы (один, два или все), используя чанки ниже. Можно письменно или голосовым:\n\n${questions.join("\n")}`
      : "Напиши по одному предложению с каждым чанком. Можно письменно или голосовым:";
    await send(
      env,
      chatId,
      `${head}📝 Задание\n\n${intro}\n\nЧанки:\n${picked.map((chunk) => `• ${chunk}`).join("\n")}`,
      next,
    );
    return;
  }

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

  if (action === "task") {
    const student = await db.studentByTelegram(userId);
    if (!student) return;
    const state = await db.getState(userId);
    const chunks = [];
    for (const chunkId of state.session || []) {
      const chunk = await db.chunk(chunkId, student.id);
      if (chunk && !chunks.includes(chunk.text)) chunks.push(chunk.text);
    }
    if (!chunks.length) {
      await send(env, chatId, "Сначала пройди карточки, тогда появится задание.");
      return;
    }
    await telegram(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId });
    const questions = await makeQuestions(env, chunks);
    await db.setState(userId, { ...state, awaiting: "task", task: { chunks, questions } });
    const intro = questions
      ? `Ответь на вопросы (один, два или все), используя чанки ниже. Можно письменно или голосовым:\n\n${questions.join("\n")}`
      : "Напиши по одному предложению с каждым чанком. Можно письменно или голосовым:";
    await send(
      env,
      chatId,
      `📝 Задание\n\n${intro}\n\nЧанки:\n${chunks.map((chunk) => `• ${chunk}`).join("\n")}`,
      { inline_keyboard: [[inline("← Назад", "taskback")]] },
    );
    return;
  }

  // Назад: задание отменяется, снова выбор «Ещё 10 / Закончить».
  if (action === "taskback") {
    const student = await db.studentByTelegram(userId);
    if (!student) return;
    const { awaiting, task, ...rest } = await db.getState(userId);
    await db.setState(userId, rest);
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: SESSION_END_TEXT,
      reply_markup: sessionEndKeyboard(),
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
      const counter = number ? `${number}/${CARD_SESSION}\n\n` : "";
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
            pronunciationRow(chunk.text, await db.phraseTerms(chunk.text.trim().toLowerCase())),
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
  } else if (action === "nextframe") {
    await askNextFrame(env, db, chatId, userId, student.id);
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
  if (message && message.voice && message.from) {
    await onVoice(env, db, message);
    return;
  }
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
// Напоминание преподавательнице за REMIND_BEFORE минут до урока.
export async function sendLessonReminders(env, db, now = clock(env)) {
  if (!env.TEACHER_ID) return;
  const due = [
    ...dueReminders(await db.allSlots(), now.date, now.time),
    ...(await db.plannedOn(now.date))
      .filter((plan) => inReminderWindow(plan.lesson_time, now.time))
      .map((plan) => ({ student_id: plan.student_id, name: plan.name, time: plan.lesson_time })),
  ];
  for (const slot of due) {
    if (!(await db.claimReminder(slot.student_id, now.date, slot.time))) continue;
    const compact = slot.time.replace(":", "");
    const data = `${slot.student_id}:${now.date}:${compact}`;
    await send(env, env.TEACHER_ID, `Через ${REMIND_BEFORE} минут урок: ${slot.name}, ${slot.time}. Будет?`, {
      inline_keyboard: [
        [inline("✅ Да, списать", `lessonyes:${data}`)],
        [inline("❌ Нет", `lessonno:${data}`)],
        [inline("🔁 Перенос", `lessonmove:${data}`)],
      ],
    });
  }
}

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
          const choice = "Выбирай в меню, чем сегодня займёшься 👇";
          await send(
            env,
            chatId,
            `${title}${cardDetails(chunk)}\n\n${friendly}\n${choice}`,
            null,
            boldChunk(chunk, title.length),
          );
        }
      }
      if (student.notify_frame) {
        const chunk = await db.randomFrame(student.id);
        if (chunk) {
          const task = frameTask(chunk.frame, "Задание дня\n\n");
          await send(
            env,
            chatId,
            task.text,
            { inline_keyboard: [[inline("Ответить", `frame:${chunk.id}`)]] },
            task.entities,
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
    ctx.waitUntil(
      openDb(env).then((db) => Promise.all([sendNotifications(env, db), sendLessonReminders(env, db)])),
    );
  },
};
