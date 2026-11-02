import asyncio
import os
import tempfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["TEACHER_ID"] = "1"

import bot
from database import Database

DAY = "2026-11-02"


def fresh_db():
    return Database(os.path.join(tempfile.mkdtemp(), "t.db"))


def fake_update(user_id, text):
    message = SimpleNamespace(text=text, reply_text=AsyncMock())
    return SimpleNamespace(
        message=message, effective_user=SimpleNamespace(id=user_id)
    )


def fake_context(**user_data):
    return SimpleNamespace(
        user_data=user_data, args=[], bot=SimpleNamespace(send_message=AsyncMock())
    )


def test_code_links_to_one_telegram_only():
    db = fresh_db()
    code = db.add_student("Анна")
    assert db.link_student(code.lower(), 10) == "Анна"
    assert db.link_student(code, 10) == "Анна"
    assert db.link_student(code, 11) is None
    assert db.link_student("WRONG1", 12) is None


def test_review_schedule():
    db = fresh_db()
    code = db.add_student("Анна")
    student = db.students()[0]
    db.add_chunk(student["id"], "used to", "", "", "", DAY)
    card = db.next_card(student["id"], DAY)
    db.review(card["id"], student["id"], True, DAY)
    assert db.next_card(student["id"], DAY) is None
    assert db.next_card(student["id"], "2026-11-05")["box"] == 2
    db.review(card["id"], student["id"], False, DAY)
    assert db.next_card(student["id"], "2026-11-03")["box"] == 1


def test_student_cannot_touch_other_chunks():
    db = fresh_db()
    db.add_student("Анна")
    db.add_student("Борис")
    first, second = db.students()
    db.add_chunk(first["id"], "secret", "", "", "", DAY)
    chunk_id = db.chunks(first["id"])[0]["id"]
    assert db.chunk(chunk_id, second["id"]) is None
    db.review(chunk_id, second["id"], True, DAY)
    assert db.chunks(first["id"])[0]["box"] == 1


def test_daily_chunk_rotates():
    db = fresh_db()
    db.add_student("Анна")
    student = db.students()[0]
    db.add_chunk(student["id"], "a", "", "", "", DAY)
    db.add_chunk(student["id"], "b", "", "", "", DAY)
    sent = {
        db.next_daily_chunk(student["id"], "2026-11-02")["text"],
        db.next_daily_chunk(student["id"], "2026-11-03")["text"],
    }
    assert sent == {"a", "b"}


def test_notification_due_once_per_day():
    db = fresh_db()
    code = db.add_student("Анна")
    db.link_student(code, 10)
    assert db.students_to_notify("09:59", DAY) == []
    assert len(db.students_to_notify("10:00", DAY)) == 1
    db.mark_notified(db.students()[0]["id"], DAY)
    assert db.students_to_notify("23:00", DAY) == []
    assert len(db.students_to_notify("10:00", "2026-11-03")) == 1


def test_parse_chunks():
    rows = bot.parse_chunks("used to | раньше | ex | I used to...\n\nmake sense")
    assert rows == [
        ["used to", "раньше", "ex", "I used to..."],
        ["make sense", "", "", ""],
    ]


def test_full_flow():
    bot.db = fresh_db()
    code = bot.db.add_student("Анна")
    student_id = bot.db.students()[0]["id"]

    # Преподаватель добавляет лексику.
    update = fake_update(1, "used to | раньше | I used to teach. | I used to...")
    asyncio.run(bot.on_text(update, fake_context(adding_for=student_id)))
    assert len(bot.db.chunks(student_id)) == 1

    # Чужой человек не может добавить лексику.
    update = fake_update(99, "hack | x")
    asyncio.run(bot.on_text(update, fake_context(adding_for=student_id)))
    assert len(bot.db.chunks(student_id)) == 1

    # Студент входит по ID и отвечает на задание.
    update = fake_update(10, code)
    asyncio.run(bot.on_text(update, fake_context()))
    assert bot.db.student(student_id)["telegram_id"] == 10

    context = fake_context()
    asyncio.run(bot.on_text(fake_update(10, bot.FRAMES), context))
    assert context.user_data["frame"] == "I used to..."
    asyncio.run(bot.on_text(fake_update(10, "work in an office"), context))
    assert bot.db.recent_answers()[0]["answer"] == "work in an office"
    context.bot.send_message.assert_awaited_once()
