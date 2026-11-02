// Хранение данных бота в базе Cloudflare D1.

// Через сколько дней повторять чанк на каждом уровне знания.
const INTERVALS = { 1: 1, 2: 3, 3: 7, 4: 14, 5: 30 };
// Без похожих символов (0/O, 1/I), чтобы код было легко ввести.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Предыдущий день в формате YYYY-MM-DD.
export function previousDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
// Сколько студентов обрабатывать за один запуск расписания:
// бесплатный тариф ограничивает число запросов к Telegram.
export const NOTIFY_BATCH = 10;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    telegram_id INTEGER UNIQUE,
    notify_time TEXT NOT NULL DEFAULT '10:00',
    notify_chunk INTEGER NOT NULL DEFAULT 1,
    notify_frame INTEGER NOT NULL DEFAULT 0,
    notify_train INTEGER NOT NULL DEFAULT 0,
    last_notified TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    translation TEXT NOT NULL DEFAULT '',
    example TEXT NOT NULL DEFAULT '',
    frame TEXT NOT NULL DEFAULT '',
    box INTEGER NOT NULL DEFAULT 1,
    due_date TEXT NOT NULL,
    last_sent TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    frame TEXT NOT NULL,
    answer TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    lesson_date TEXT NOT NULL,
    text TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS student_stats (
    student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    last_seen TEXT,
    own_chunks INTEGER NOT NULL DEFAULT 0,
    cards_done INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS student_progress (
    student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    last_day TEXT,
    quiz_total INTEGER NOT NULL DEFAULT 0,
    quiz_correct INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS quiz_polls (
    poll_id TEXT PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    correct_index INTEGER NOT NULL,
    answered INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS user_state (
    telegram_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  // Термины для словаря: Claude заполняет при добавлении чанка, карточка только читает.
  `CREATE TABLE IF NOT EXISTS phrase_terms (
    phrase TEXT PRIMARY KEY,
    terms TEXT NOT NULL
  )`,
];

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

export class Database {
  constructor(d1) {
    this.d1 = d1;
  }

  init() {
    return this.d1.batch(SCHEMA.map((sql) => this.d1.prepare(sql)));
  }

  one(sql, ...params) {
    return this.d1.prepare(sql).bind(...params).first();
  }

  async many(sql, ...params) {
    return (await this.d1.prepare(sql).bind(...params).all()).results;
  }

  run(sql, ...params) {
    return this.d1.prepare(sql).bind(...params).run();
  }

  // ---------- Что бот ждёт от пользователя ----------
  async getState(telegramId) {
    const row = await this.one(
      "SELECT data FROM user_state WHERE telegram_id = ?",
      telegramId,
    );
    return row ? JSON.parse(row.data) : {};
  }

  setState(telegramId, state) {
    return this.run(
      `INSERT INTO user_state (telegram_id, data) VALUES (?, ?)
       ON CONFLICT (telegram_id) DO UPDATE SET data = excluded.data`,
      telegramId,
      JSON.stringify(state),
    );
  }

  clearState(telegramId) {
    return this.run("DELETE FROM user_state WHERE telegram_id = ?", telegramId);
  }

  // ---------- Студенты ----------
  async addStudent(name) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomCode();
      const taken = await this.one("SELECT id FROM students WHERE code = ?", code);
      if (!taken) {
        await this.run("INSERT INTO students (name, code) VALUES (?, ?)", name, code);
        return code;
      }
    }
    throw new Error("Could not create a unique student code");
  }

  students() {
    return this.many("SELECT * FROM students ORDER BY name");
  }

  student(id) {
    return this.one("SELECT * FROM students WHERE id = ?", id);
  }

  renameStudent(id, name) {
    return this.run("UPDATE students SET name = ? WHERE id = ?", name, id);
  }

  // Удаляет студента вместе с лексикой, ответами, заметками и прогрессом.
  deleteStudent(id) {
    return this.d1.batch([
      this.d1.prepare("DELETE FROM quiz_polls WHERE student_id = ?").bind(id),
      this.d1.prepare("DELETE FROM answers WHERE student_id = ?").bind(id),
      this.d1.prepare("DELETE FROM notes WHERE student_id = ?").bind(id),
      this.d1.prepare("DELETE FROM chunks WHERE student_id = ?").bind(id),
      this.d1.prepare("DELETE FROM student_stats WHERE student_id = ?").bind(id),
      this.d1.prepare("DELETE FROM student_progress WHERE student_id = ?").bind(id),
      this.d1.prepare("DELETE FROM students WHERE id = ?").bind(id),
    ]);
  }

  studentByTelegram(telegramId) {
    return this.one("SELECT * FROM students WHERE telegram_id = ?", telegramId);
  }

  // Привязывает код к Telegram. Занятый чужой код не срабатывает.
  async linkStudent(code, telegramId) {
    const row = await this.one(
      "SELECT * FROM students WHERE code = ?",
      code.trim().toUpperCase(),
    );
    if (!row || (row.telegram_id !== null && row.telegram_id !== telegramId)) {
      return null;
    }
    await this.run(
      "UPDATE students SET telegram_id = ? WHERE id = ?",
      telegramId,
      row.id,
    );
    return row.name;
  }

  // Освобождает ID: под ним снова можно войти с любого аккаунта.
  unlinkStudent(telegramId) {
    return this.run(
      "UPDATE students SET telegram_id = NULL WHERE telegram_id = ?",
      telegramId,
    );
  }

  toggleNotification(studentId, kind) {
    const column = {
      chunk: "notify_chunk",
      frame: "notify_frame",
      train: "notify_train",
    }[kind];
    if (!column) return null;
    return this.run(
      `UPDATE students SET ${column} = 1 - ${column} WHERE id = ?`,
      studentId,
    );
  }

  // skipDay: день, за который рассылка уже не нужна (или null).
  setNotifyTime(studentId, value, skipDay) {
    return this.run(
      "UPDATE students SET notify_time = ?, last_notified = ? WHERE id = ?",
      value,
      skipDay,
      studentId,
    );
  }

  studentsToNotify(nowTime, today) {
    return this.many(
      `SELECT * FROM students
       WHERE telegram_id IS NOT NULL
         AND notify_time <= ?
         AND (last_notified IS NULL OR last_notified < ?)
         AND (notify_chunk = 1 OR notify_frame = 1 OR notify_train = 1)
       ORDER BY notify_time LIMIT ?`,
      nowTime,
      today,
      NOTIFY_BATCH,
    );
  }

  markNotified(studentId, today) {
    return this.run(
      "UPDATE students SET last_notified = ? WHERE id = ?",
      today,
      studentId,
    );
  }

  // ---------- Чанки ----------
  addChunks(studentIds, rows, today) {
    const statement = this.d1.prepare(
      `INSERT INTO chunks (student_id, text, translation, example, frame, due_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const inserts = studentIds.flatMap((studentId) =>
      rows.map(([text, translation, example, frame]) =>
        statement.bind(studentId, text, translation, example, frame, today),
      ),
    );
    return this.d1.batch(inserts);
  }

  chunks(studentId) {
    return this.many(
      "SELECT * FROM chunks WHERE student_id = ? ORDER BY id DESC",
      studentId,
    );
  }

  // Студент может получить только свой чанк.
  chunk(chunkId, studentId) {
    return this.one(
      "SELECT * FROM chunks WHERE id = ? AND student_id = ?",
      chunkId,
      studentId,
    );
  }

  // Возвращает номера, которых нет в базе.
  async deleteChunks(chunkIds) {
    const missing = [];
    for (const chunkId of chunkIds) {
      const result = await this.run("DELETE FROM chunks WHERE id = ?", chunkId);
      if (result.meta.changes === 0) missing.push(chunkId);
    }
    return missing;
  }

  nextCard(studentId, today) {
    return this.one(
      `SELECT * FROM chunks WHERE student_id = ? AND due_date <= ?
       ORDER BY due_date, RANDOM() LIMIT 1`,
      studentId,
      today,
    );
  }

  async dueCount(studentId, today) {
    const row = await this.one(
      "SELECT COUNT(*) AS total FROM chunks WHERE student_id = ? AND due_date <= ?",
      studentId,
      today,
    );
    return row.total;
  }

  // «Знаю» отодвигает повтор, «Повторить» возвращает чанк на завтра.
  async review(chunkId, studentId, known, today) {
    const chunk = await this.chunk(chunkId, studentId);
    if (!chunk) return;
    const box = known ? Math.min(chunk.box + 1, 5) : 1;
    const due = new Date(`${today}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + INTERVALS[box]);
    await this.run(
      "UPDATE chunks SET box = ?, due_date = ? WHERE id = ?",
      box,
      due.toISOString().slice(0, 10),
      chunkId,
    );
  }

  // Чанк дня: сначала те, что дольше всего не приходили.
  async nextDailyChunk(studentId, today) {
    const row = await this.one(
      `SELECT * FROM chunks WHERE student_id = ?
       ORDER BY last_sent IS NOT NULL, last_sent, RANDOM() LIMIT 1`,
      studentId,
    );
    if (row) {
      await this.run("UPDATE chunks SET last_sent = ? WHERE id = ?", today, row.id);
    }
    return row;
  }

  randomFrame(studentId) {
    return this.one(
      `SELECT * FROM chunks WHERE student_id = ? AND frame != ''
       ORDER BY RANDOM() LIMIT 1`,
      studentId,
    );
  }

  // Начало с чистого листа: лексика и заметки остаются.
  resetProgress(studentId, today) {
    return this.d1.batch([
      this.d1
        .prepare(
          "UPDATE chunks SET box = 1, due_date = ?, last_sent = NULL WHERE student_id = ?",
        )
        .bind(today, studentId),
      this.d1.prepare("UPDATE student_stats SET cards_done = 0 WHERE student_id = ?").bind(studentId),
      this.d1
        .prepare(
          `UPDATE student_progress SET streak = 0, best_streak = 0, last_day = NULL,
             quiz_total = 0, quiz_correct = 0 WHERE student_id = ?`,
        )
        .bind(studentId),
      this.d1.prepare("DELETE FROM answers WHERE student_id = ?").bind(studentId),
      this.d1
        .prepare(
          `UPDATE students SET notify_time = '10:00', notify_chunk = 1, notify_frame = 0,
             notify_train = 0, last_notified = NULL WHERE id = ?`,
        )
        .bind(studentId),
    ]);
  }

  // ---------- Активность ----------
  // Отмечает активность студента и считает серию дней подряд.
  async touch(studentId, when, day) {
    await this.run(
      `INSERT INTO student_stats (student_id, last_seen) VALUES (?, ?)
       ON CONFLICT (student_id) DO UPDATE SET last_seen = excluded.last_seen`,
      studentId,
      when,
    );
    const row = await this.one(
      "SELECT streak, best_streak, last_day FROM student_progress WHERE student_id = ?",
      studentId,
    );
    if (row && row.last_day === day) return;
    const streak = row && row.last_day === previousDay(day) ? row.streak + 1 : 1;
    const best = Math.max(row ? row.best_streak : 0, streak);
    await this.run(
      `INSERT INTO student_progress (student_id, streak, best_streak, last_day)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (student_id) DO UPDATE SET streak = excluded.streak,
         best_streak = excluded.best_streak, last_day = excluded.last_day`,
      studentId,
      streak,
      best,
      day,
    );
  }

  // Серия, которая ещё действует на указанный день (0, если прервалась).
  async currentStreak(studentId, day) {
    const row = await this.one(
      "SELECT streak, last_day FROM student_progress WHERE student_id = ?",
      studentId,
    );
    if (!row) return 0;
    return row.last_day === day || row.last_day === previousDay(day) ? row.streak : 0;
  }

  incrementProgress(studentId, column) {
    if (!["quiz_total", "quiz_correct"].includes(column)) {
      throw new Error(`Unknown progress column: ${column}`);
    }
    return this.run(
      `INSERT INTO student_progress (student_id, ${column}) VALUES (?, 1)
       ON CONFLICT (student_id) DO UPDATE SET ${column} = ${column} + 1`,
      studentId,
    );
  }

  async progressRow(studentId) {
    const progress =
      (await this.one("SELECT * FROM student_progress WHERE student_id = ?", studentId)) || {};
    const stats =
      (await this.one("SELECT * FROM student_stats WHERE student_id = ?", studentId)) || {};
    const chunks = await this.one(
      "SELECT COUNT(*) AS total FROM chunks WHERE student_id = ?",
      studentId,
    );
    const answers = await this.one(
      "SELECT COUNT(*) AS total FROM answers WHERE student_id = ?",
      studentId,
    );
    return {
      streak: progress.streak || 0,
      best_streak: progress.best_streak || 0,
      quiz_total: progress.quiz_total || 0,
      quiz_correct: progress.quiz_correct || 0,
      own_chunks: stats.own_chunks || 0,
      cards_done: stats.cards_done || 0,
      chunks: chunks.total,
      answers: answers.total,
    };
  }

  // ---------- Термины для словаря ----------
  // Возвращает массив терминов или null, если фраза ещё не классифицирована.
  async phraseTerms(phrase) {
    const row = await this.one("SELECT terms FROM phrase_terms WHERE phrase = ?", phrase);
    return row ? JSON.parse(row.terms) : null;
  }

  // Все уже классифицированные фразы одним запросом.
  async knownPhrases() {
    const rows = await this.many("SELECT phrase FROM phrase_terms");
    return new Set(rows.map((row) => row.phrase));
  }

  savePhraseTerms(list) {
    if (!list.length) return Promise.resolve();
    return this.d1.batch(
      list.map((item) =>
        this.d1
          .prepare("INSERT OR REPLACE INTO phrase_terms (phrase, terms) VALUES (?, ?)")
          .bind(item.phrase, JSON.stringify(item.terms)),
      ),
    );
  }

  // ---------- Квиз ----------
  saveQuiz(pollId, studentId, correctIndex) {
    return this.run(
      "INSERT INTO quiz_polls (poll_id, student_id, correct_index) VALUES (?, ?, ?)",
      pollId,
      studentId,
      correctIndex,
    );
  }

  quizPoll(pollId) {
    return this.one("SELECT * FROM quiz_polls WHERE poll_id = ?", pollId);
  }

  // Засчитывается только первый ответ: повторные изменения игнорируются.
  async answerQuiz(pollId, studentId, correct) {
    await this.run("UPDATE quiz_polls SET answered = 1 WHERE poll_id = ?", pollId);
    await this.incrementProgress(studentId, "quiz_total");
    if (correct) await this.incrementProgress(studentId, "quiz_correct");
  }

  increment(studentId, column, by = 1) {
    if (!["own_chunks", "cards_done"].includes(column)) {
      throw new Error(`Unknown stat: ${column}`);
    }
    return this.run(
      `INSERT INTO student_stats (student_id, ${column}) VALUES (?, ?)
       ON CONFLICT (student_id) DO UPDATE SET ${column} = ${column} + excluded.${column}`,
      studentId,
      by,
    );
  }

  stats() {
    return this.many(
      `SELECT s.id, s.name, s.telegram_id, st.last_seen,
              COALESCE(st.own_chunks, 0) AS own_chunks,
              COALESCE(st.cards_done, 0) AS cards_done,
              COALESCE(pr.streak, 0) AS streak,
              (SELECT COUNT(*) FROM chunks c WHERE c.student_id = s.id) AS chunks,
              (SELECT COUNT(*) FROM answers a WHERE a.student_id = s.id) AS answers
       FROM students s
       LEFT JOIN student_stats st ON st.student_id = s.id
       LEFT JOIN student_progress pr ON pr.student_id = s.id
       ORDER BY s.name`,
    );
  }

  // ---------- Заметки с уроков ----------
  addNote(studentId, lessonDate, text) {
    return this.run(
      "INSERT INTO notes (student_id, lesson_date, text) VALUES (?, ?, ?)",
      studentId,
      lessonDate,
      text,
    );
  }

  // Telegram ограничивает число кнопок в сообщении, поэтому берём 90 последних.
  notes(studentId, limit = 90) {
    return this.many(
      "SELECT * FROM notes WHERE student_id = ? ORDER BY id DESC LIMIT ?",
      studentId,
      limit,
    );
  }

  // Студент может открыть только свою заметку.
  note(noteId, studentId) {
    return this.one(
      "SELECT * FROM notes WHERE id = ? AND student_id = ?",
      noteId,
      studentId,
    );
  }

  // ---------- Ответы ----------
  addAnswer(studentId, frame, answer) {
    return this.run(
      "INSERT INTO answers (student_id, frame, answer) VALUES (?, ?, ?)",
      studentId,
      frame,
      answer,
    );
  }

  // Сколько ответов студент дал за последние сутки.
  async answersLastDay(studentId) {
    const row = await this.one(
      `SELECT COUNT(*) AS total FROM answers
       WHERE student_id = ? AND created_at >= datetime('now', '-1 day')`,
      studentId,
    );
    return row.total;
  }

  recentAnswers(limit = 20) {
    return this.many(
      `SELECT students.name, answers.frame, answers.answer
       FROM answers JOIN students ON students.id = answers.student_id
       ORDER BY answers.id DESC LIMIT ?`,
      limit,
    );
  }
}
