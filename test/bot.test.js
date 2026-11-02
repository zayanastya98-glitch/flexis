import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Database, NOTIFY_BATCH } from "../src/db.js";
import worker, { parseChunks } from "../src/index.js";

const DAY = "2026-11-02";
const TEACHER = 1;
const STUDENT = 10;

// Простая замена D1 для тестов поверх SQLite.
function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const statement = (sql, params = []) => ({
    bind: (...next) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    run: async () => ({ meta: sqlite.prepare(sql).run(...params) }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => Promise.all(items.map((item) => item.run())),
  };
}

async function environment() {
  const sent = [];
  const d1 = fakeD1();
  await new Database(d1).init();
  globalThis.fetch = async (url, options) => {
    sent.push({
      method: url.split("/").at(-1),
      body: JSON.parse(options.body),
    });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
  return {
    env: {
      DB: d1,
      BOT_TOKEN: "123:abc",
      TEACHER_ID: String(TEACHER),
      TIMEZONE: "Europe/Istanbul",
    },
    sent,
  };
}

async function freshDb() {
  const db = new Database(fakeD1());
  await db.init();
  return db;
}

async function secretFor(token) {
  const data = new TextEncoder().encode(`webhook:${token}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(hash).toString("hex");
}

async function post(env, update, secret) {
  return worker.fetch(
    new Request("https://bot.test/telegram", {
      method: "POST",
      headers: {
        "x-telegram-bot-api-secret-token": secret ?? (await secretFor(env.BOT_TOKEN)),
      },
      body: JSON.stringify(update),
    }),
    env,
  );
}

function say(env, userId, text) {
  return post(env, {
    message: { text, chat: { id: userId }, from: { id: userId } },
  });
}

function press(env, userId, data) {
  return post(env, {
    callback_query: {
      id: "q",
      data,
      from: { id: userId },
      message: { message_id: 5, chat: { id: userId } },
    },
  });
}

function lastText(sent) {
  return sent.at(-1).body.text;
}

async function runCron(env) {
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
}

test("код студента привязывается только к одному Telegram", async () => {
  const db = await freshDb();
  const code = await db.addStudent("Анна");
  assert.equal(await db.linkStudent(code.toLowerCase(), 10), "Анна");
  assert.equal(await db.linkStudent(code, 10), "Анна");
  assert.equal(await db.linkStudent(code, 11), null);
  assert.equal(await db.linkStudent("WRONG1", 12), null);
});

test("расписание карточек", async () => {
  const db = await freshDb();
  await db.addStudent("Анна");
  const [student] = await db.students();
  await db.addChunks([student.id], [["used to", "", "", ""]], DAY);
  const card = await db.nextCard(student.id, DAY);
  await db.review(card.id, student.id, true, DAY);
  assert.equal(await db.nextCard(student.id, DAY), null);
  assert.equal((await db.nextCard(student.id, "2026-11-05")).box, 2);
  await db.review(card.id, student.id, false, DAY);
  assert.equal((await db.nextCard(student.id, "2026-11-03")).box, 1);
});

test("студент не трогает чужие чанки", async () => {
  const db = await freshDb();
  await db.addStudent("Анна");
  await db.addStudent("Борис");
  const [first, second] = await db.students();
  await db.addChunks([first.id], [["secret", "", "", ""]], DAY);
  const [chunk] = await db.chunks(first.id);
  assert.equal(await db.chunk(chunk.id, second.id), null);
  await db.review(chunk.id, second.id, true, DAY);
  assert.equal((await db.chunks(first.id))[0].box, 1);
});

test("чанк дня меняется", async () => {
  const db = await freshDb();
  await db.addStudent("Анна");
  const [student] = await db.students();
  await db.addChunks([student.id], [["a", "", "", ""], ["b", "", "", ""]], DAY);
  const sent = new Set([
    (await db.nextDailyChunk(student.id, "2026-11-02")).text,
    (await db.nextDailyChunk(student.id, "2026-11-03")).text,
  ]);
  assert.deepEqual(sent, new Set(["a", "b"]));
});

test("уведомление приходит раз в день", async () => {
  const db = await freshDb();
  const code = await db.addStudent("Анна");
  await db.linkStudent(code, 10);
  assert.equal((await db.studentsToNotify("09:59", DAY)).length, 0);
  assert.equal((await db.studentsToNotify("10:00", DAY)).length, 1);
  const [student] = await db.students();
  await db.markNotified(student.id, DAY);
  assert.equal((await db.studentsToNotify("23:00", DAY)).length, 0);
  assert.equal((await db.studentsToNotify("10:00", "2026-11-03")).length, 1);
});

test("уведомления уходят порциями", async () => {
  const db = await freshDb();
  for (let index = 0; index < NOTIFY_BATCH + 3; index += 1) {
    await db.linkStudent(await db.addStudent(`С${index}`), 100 + index);
  }
  assert.equal((await db.studentsToNotify("10:00", DAY)).length, NOTIFY_BATCH);
});

test("разбор чанков", () => {
  assert.deepEqual(parseChunks("used to | раньше | ex | I used to...\n\nmake sense"), [
    ["used to", "раньше", "ex", "I used to..."],
    ["make sense", "", "", ""],
  ]);
});

test("запрос без секрета отклоняется", async () => {
  const { env, sent } = await environment();
  const response = await post(env, { message: {} }, "wrong");
  assert.equal(response.status, 403);
  assert.equal(sent.length, 0);
});

test("/setup подключает бота и не раскрывает секреты", async () => {
  const { env, sent } = await environment();
  const response = await worker.fetch(new Request("https://bot.test/setup"), env);
  assert.equal(response.status, 200);
  assert.equal(sent[0].method, "setWebhook");
  assert.equal(sent[0].body.url, "https://bot.test/telegram");
  assert.equal(sent[0].body.secret_token, await secretFor(env.BOT_TOKEN));
  assert.ok(!(await response.text()).includes(env.BOT_TOKEN));
});

test("полный сценарий: преподаватель и студент", async () => {
  const { env, sent } = await environment();

  await say(env, TEACHER, "/addstudent Анна Мария");
  const code = lastText(sent).split("ID ")[1];
  assert.match(lastText(sent), /^Анна Мария: ID /);

  // Посторонний не может создать студента.
  const before = sent.length;
  await say(env, 99, "/addstudent Хакер");
  assert.equal(sent.length, before);

  await say(env, TEACHER, "/add");
  const pick = sent.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
  await press(env, TEACHER, pick);
  await say(env, TEACHER, "used to | раньше | I used to teach. | I used to...");
  assert.equal(lastText(sent), "Добавлено чанков: 1.");

  // Посторонний с этой кнопкой не начинает добавление.
  await press(env, 99, pick);
  await say(env, 99, "hack | x");
  assert.match(lastText(sent), /Такого ID нет/);

  await say(env, STUDENT, code);
  assert.match(lastText(sent), /^Привеет :\)/);
  assert.ok(sent.at(-1).body.reply_markup.keyboard);

  await say(env, STUDENT, "🃏 Карточки");
  assert.equal(lastText(sent), "used to");
  assert.equal(sent.at(-1).body.entities[0].length, "used to".length);
  const show = sent.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
  await press(env, STUDENT, show);
  assert.match(lastText(sent), /Перевод: раньше/);
  const chunkId = show.split(":")[1];
  await press(env, STUDENT, `know:${chunkId}`);
  assert.match(lastText(sent), /карточек нет/);

  await say(env, STUDENT, "✍️ Закончи фразу");
  assert.match(lastText(sent), /I used to\.\.\./);
  await say(env, STUDENT, "I used to work in an office");
  assert.equal(sent.at(-1).body.chat_id, String(TEACHER));
  assert.match(lastText(sent), /I used to work in an office/);

  await say(env, TEACHER, "/answers");
  assert.match(lastText(sent), /→ I used to work in an office/);
});

test("настройка времени и рассылка по расписанию", async () => {
  const { env, sent } = await environment();
  await say(env, TEACHER, "/addstudent Анна");
  const code = lastText(sent).split("ID ")[1];
  await say(env, STUDENT, code);

  await press(env, STUDENT, "settime");
  await say(env, STUDENT, "завтра");
  assert.equal(lastText(sent), "Напиши время так: 09:30");
  await say(env, STUDENT, "9.30");
  assert.equal(lastText(sent), "Готово, буду писать в 09:30.");

  await press(env, STUDENT, "notify:frame");
  const db = new Database(env.DB);
  const [student] = await db.students();
  assert.equal(student.notify_frame, 1);

  await db.addChunks([student.id], [["used to", "раньше", "", "I used to..."]], DAY);
  await db.setNotifyTime(student.id, "00:00", null);
  await runCron(env);
  const texts = sent.map((item) => item.body.text);
  const daily = sent.find((item) => item.body.text?.startsWith("Чанк дня"));
  const [bold] = daily.body.entities;
  assert.equal(bold.type, "bold");
  assert.equal(daily.body.text.slice(bold.offset, bold.offset + bold.length), "used to");
  assert.ok(texts.some((text) => text?.startsWith("Задание дня")));

  const count = sent.length;
  await runCron(env);
  assert.equal(sent.length, count);
});

test("студент добавляет свои чанки", async () => {
  const { env, sent } = await environment();
  await say(env, TEACHER, "/addstudent Анна");
  await say(env, TEACHER, "/addstudent Борис");
  const db = new Database(env.DB);
  const [anna, boris] = await db.students();
  await say(env, STUDENT, anna.code);

  await say(env, STUDENT, "➕ Добавить чанк");
  await say(env, STUDENT, "look forward to | ждать с нетерпением\nmake sense");
  assert.equal(sent.at(-1).body.chat_id, String(TEACHER));
  assert.match(lastText(sent), /Анна добавляет лексику/);
  assert.match(lastText(sent), /look forward to \| ждать с нетерпением/);

  assert.equal((await db.chunks(anna.id)).length, 2);
  assert.equal((await db.chunks(boris.id)).length, 0);

  await say(env, STUDENT, "🃏 Карточки");
  assert.match(lastText(sent), /look forward to|make sense/);

  // Следующее сообщение уже не считается чанком.
  await say(env, STUDENT, "просто текст");
  assert.equal(lastText(sent), "Выбери действие в меню 👇");
  assert.equal((await db.chunks(anna.id)).length, 2);

  // Кнопка меню отменяет добавление и не становится чанком.
  await say(env, STUDENT, "➕ Добавить чанк");
  await say(env, STUDENT, "🔔 Уведомления");
  assert.equal((await db.chunks(anna.id)).length, 2);

  await say(env, STUDENT, "➕ Добавить чанк");
  await say(env, STUDENT, Array(21).fill("x").join("\n"));
  assert.match(lastText(sent), /до 20 чанков/);
  assert.equal((await db.chunks(anna.id)).length, 2);
});

test("выход освобождает ID и позволяет войти другим студентом", async () => {
  const { env, sent } = await environment();
  await say(env, TEACHER, "/addstudent Тест");
  await say(env, TEACHER, "/addstudent Соня");
  const db = new Database(env.DB);
  const [sonya, test] = await db.students();
  assert.equal(sonya.name, "Соня");

  await say(env, TEACHER, test.code);
  await say(env, TEACHER, "/logout");
  assert.equal((await db.student(test.id)).telegram_id, null);

  await say(env, TEACHER, sonya.code);
  assert.equal((await db.student(sonya.id)).telegram_id, TEACHER);
  await say(env, TEACHER, "/logout");

  // Настоящий студент теперь может войти под этим ID.
  await say(env, STUDENT, sonya.code);
  assert.equal((await db.student(sonya.id)).telegram_id, STUDENT);
  assert.match(lastText(sent), /^Привеет/);
});

test("заметка с урока приходит студенту и хранится", async () => {
  const { env, sent } = await environment();
  await say(env, TEACHER, "/addstudent Соня");
  await say(env, TEACHER, "/addstudent Анна");
  const db = new Database(env.DB);
  const [anna, sonya] = await db.students();
  await say(env, STUDENT, sonya.code);

  await say(env, TEACHER, "/note");
  await press(env, TEACHER, `noteto:${sonya.id}`);
  await say(env, TEACHER, "Сегодня повторили it takes\nДомашка: 3 фразы");
  const delivered = sent.at(-2);
  assert.equal(delivered.body.chat_id, STUDENT);
  assert.match(delivered.body.text, /^📝 Заметка с урока, \d{2}\.\d{2}\.\d{4}\n\nСегодня/);
  assert.match(delivered.body.text, /Домашка: 3 фразы/);
  assert.equal(lastText(sent), "Заметка отправлена: Соня.");

  await say(env, STUDENT, "📝 Заметки");
  const button = sent.at(-1).body.reply_markup.inline_keyboard[0][0];
  await press(env, STUDENT, button.callback_data);
  assert.match(lastText(sent), /Сегодня повторили/);

  // Другой студент не открывает чужую заметку.
  await say(env, 11, anna.code);
  const count = sent.length;
  await press(env, 11, button.callback_data);
  assert.equal(sent.length, count + 1);
  assert.equal(sent.at(-1).method, "answerCallbackQuery");

  // Посторонний не может отправить заметку.
  await press(env, 99, `noteto:${sonya.id}`);
  assert.deepEqual(await db.getState(99), {});

  // Заметка ждёт студента, который ещё не вошёл.
  await say(env, 11, "/logout");
  await say(env, TEACHER, "/note");
  await press(env, TEACHER, `noteto:${anna.id}`);
  await say(env, TEACHER, "Для Анны");
  assert.match(lastText(sent), /увидит её после входа/);
  assert.equal((await db.notes(anna.id)).length, 1);

  await say(env, TEACHER, "/note");
  await press(env, TEACHER, `noteto:${anna.id}`);
  await say(env, TEACHER, "x".repeat(4000));
  assert.match(lastText(sent), /слишком длинная/);
  assert.equal((await db.notes(anna.id)).length, 1);
});

test("ошибка Telegram не ломает ответ сервера", async () => {
  const { env } = await environment();
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, description: "blocked" }));
  const response = await say(env, 99, "/myid");
  assert.equal(response.status, 200);
});
