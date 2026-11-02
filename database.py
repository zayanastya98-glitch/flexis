"""Хранение данных бота: студенты, чанки и ответы."""
import secrets
import sqlite3
from datetime import date, timedelta

# Через сколько дней повторять чанк на каждом уровне знания.
INTERVALS = {1: 1, 2: 3, 3: 7, 4: 14, 5: 30}
# Без похожих символов (0/O, 1/I), чтобы код было легко ввести.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class Database:
    def __init__(self, path):
        self.path = path
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS students (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    code TEXT NOT NULL UNIQUE,
                    telegram_id INTEGER UNIQUE,
                    notify_time TEXT NOT NULL DEFAULT '10:00',
                    notify_chunk INTEGER NOT NULL DEFAULT 1,
                    notify_frame INTEGER NOT NULL DEFAULT 0,
                    notify_train INTEGER NOT NULL DEFAULT 0,
                    last_notified TEXT
                );
                CREATE TABLE IF NOT EXISTS chunks (
                    id INTEGER PRIMARY KEY,
                    student_id INTEGER NOT NULL
                        REFERENCES students(id) ON DELETE CASCADE,
                    text TEXT NOT NULL,
                    translation TEXT NOT NULL DEFAULT '',
                    example TEXT NOT NULL DEFAULT '',
                    frame TEXT NOT NULL DEFAULT '',
                    box INTEGER NOT NULL DEFAULT 1,
                    due_date TEXT NOT NULL,
                    last_sent TEXT
                );
                CREATE TABLE IF NOT EXISTS answers (
                    id INTEGER PRIMARY KEY,
                    student_id INTEGER NOT NULL
                        REFERENCES students(id) ON DELETE CASCADE,
                    frame TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

    def _connect(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    # ---------- Студенты ----------
    def add_student(self, name):
        with self._connect() as conn:
            while True:
                code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
                try:
                    conn.execute(
                        "INSERT INTO students (name, code) VALUES (?, ?)",
                        (name, code),
                    )
                    return code
                except sqlite3.IntegrityError:
                    continue

    def students(self):
        with self._connect() as conn:
            return conn.execute("SELECT * FROM students ORDER BY name").fetchall()

    def student(self, student_id):
        with self._connect() as conn:
            return conn.execute(
                "SELECT * FROM students WHERE id = ?", (student_id,)
            ).fetchone()

    def student_by_telegram(self, telegram_id):
        with self._connect() as conn:
            return conn.execute(
                "SELECT * FROM students WHERE telegram_id = ?", (telegram_id,)
            ).fetchone()

    def link_student(self, code, telegram_id):
        """Привязывает код к Telegram. Занятый чужой код не срабатывает."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM students WHERE code = ?", (code.strip().upper(),)
            ).fetchone()
            if row is None or row["telegram_id"] not in (None, telegram_id):
                return None
            conn.execute(
                "UPDATE students SET telegram_id = ? WHERE id = ?",
                (telegram_id, row["id"]),
            )
            return row["name"]

    def toggle_notification(self, student_id, kind):
        column = {
            "chunk": "notify_chunk",
            "frame": "notify_frame",
            "train": "notify_train",
        }[kind]
        with self._connect() as conn:
            conn.execute(
                f"UPDATE students SET {column} = 1 - {column} WHERE id = ?",
                (student_id,),
            )

    def set_notify_time(self, student_id, value, skip_day):
        """skip_day: день, за который рассылка уже не нужна (или None)."""
        with self._connect() as conn:
            conn.execute(
                "UPDATE students SET notify_time = ?, last_notified = ? WHERE id = ?",
                (value, skip_day, student_id),
            )

    def students_to_notify(self, now_time, today):
        with self._connect() as conn:
            return conn.execute(
                """
                SELECT * FROM students
                WHERE telegram_id IS NOT NULL
                  AND notify_time <= ?
                  AND (last_notified IS NULL OR last_notified < ?)
                  AND (notify_chunk = 1 OR notify_frame = 1 OR notify_train = 1)
                """,
                (now_time, today),
            ).fetchall()

    def mark_notified(self, student_id, today):
        with self._connect() as conn:
            conn.execute(
                "UPDATE students SET last_notified = ? WHERE id = ?",
                (today, student_id),
            )

    # ---------- Чанки ----------
    def add_chunk(self, student_id, text, translation, example, frame, today):
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO chunks
                    (student_id, text, translation, example, frame, due_date)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (student_id, text, translation, example, frame, today),
            )

    def chunks(self, student_id):
        with self._connect() as conn:
            return conn.execute(
                "SELECT * FROM chunks WHERE student_id = ? ORDER BY id DESC",
                (student_id,),
            ).fetchall()

    def chunk(self, chunk_id, student_id):
        """Студент может получить только свой чанк."""
        with self._connect() as conn:
            return conn.execute(
                "SELECT * FROM chunks WHERE id = ? AND student_id = ?",
                (chunk_id, student_id),
            ).fetchone()

    def delete_chunk(self, chunk_id):
        with self._connect() as conn:
            return conn.execute(
                "DELETE FROM chunks WHERE id = ?", (chunk_id,)
            ).rowcount > 0

    def next_card(self, student_id, today):
        with self._connect() as conn:
            return conn.execute(
                """
                SELECT * FROM chunks
                WHERE student_id = ? AND due_date <= ?
                ORDER BY due_date, RANDOM() LIMIT 1
                """,
                (student_id, today),
            ).fetchone()

    def due_count(self, student_id, today):
        with self._connect() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM chunks WHERE student_id = ? AND due_date <= ?",
                (student_id, today),
            ).fetchone()[0]

    def review(self, chunk_id, student_id, known, today):
        """«Знаю» отодвигает повтор, «Повторить» возвращает чанк на завтра."""
        chunk = self.chunk(chunk_id, student_id)
        if chunk is None:
            return
        box = min(chunk["box"] + 1, 5) if known else 1
        due = date.fromisoformat(today) + timedelta(days=INTERVALS[box])
        with self._connect() as conn:
            conn.execute(
                "UPDATE chunks SET box = ?, due_date = ? WHERE id = ?",
                (box, due.isoformat(), chunk_id),
            )

    def next_daily_chunk(self, student_id, today):
        """Чанк дня: сначала те, что дольше всего не приходили."""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM chunks WHERE student_id = ?
                ORDER BY last_sent IS NOT NULL, last_sent, RANDOM() LIMIT 1
                """,
                (student_id,),
            ).fetchone()
            if row:
                conn.execute(
                    "UPDATE chunks SET last_sent = ? WHERE id = ?",
                    (today, row["id"]),
                )
            return row

    def random_frame(self, student_id):
        with self._connect() as conn:
            return conn.execute(
                """
                SELECT * FROM chunks WHERE student_id = ? AND frame != ''
                ORDER BY RANDOM() LIMIT 1
                """,
                (student_id,),
            ).fetchone()

    # ---------- Ответы ----------
    def add_answer(self, student_id, frame, answer):
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO answers (student_id, frame, answer) VALUES (?, ?, ?)",
                (student_id, frame, answer),
            )

    def recent_answers(self, limit=20):
        with self._connect() as conn:
            return conn.execute(
                """
                SELECT students.name, answers.frame, answers.answer
                FROM answers JOIN students ON students.id = answers.student_id
                ORDER BY answers.id DESC LIMIT ?
                """,
                (limit,),
            ).fetchall()
