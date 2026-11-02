"""Telegram-бот для отработки чанков. Настройка описана в README.md."""
import logging
import os
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    Update,
)
from telegram.error import TelegramError
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from database import Database

load_dotenv()
logging.basicConfig(level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger(__name__)

TEACHER_ID = int(os.getenv("TEACHER_ID") or 0)
TIMEZONE = ZoneInfo(os.getenv("TIMEZONE") or "Europe/Istanbul")
db = Database(os.getenv("DB_PATH") or "bot.db")

CARDS = "🃏 Карточки"
FRAMES = "✍️ Закончи фразу"
NOTIFICATIONS = "🔔 Уведомления"
MENU = ReplyKeyboardMarkup(
    [[KeyboardButton(CARDS), KeyboardButton(FRAMES)], [KeyboardButton(NOTIFICATIONS)]],
    resize_keyboard=True,
)
ADD_FORMAT = (
    "Пришли чанки, каждый с новой строки:\n"
    "чанк | перевод | пример для студента | начало фразы\n\n"
    "Например:\n"
    "used to | раньше (привычка) | I used to teach in a school. | I used to...\n\n"
    "Обязателен только чанк. /cancel — отмена."
)


def now():
    return datetime.now(TIMEZONE)


def today():
    return now().date().isoformat()


def is_teacher(update):
    return TEACHER_ID != 0 and update.effective_user.id == TEACHER_ID


def parse_chunks(text):
    """Разбирает строки «чанк | перевод | пример | начало фразы»."""
    rows = []
    for line in text.splitlines():
        parts = [part.strip() for part in line.split("|")]
        if not parts[0]:
            continue
        parts = (parts + ["", "", ""])[:4]
        rows.append(parts)
    return rows


def card_details(chunk):
    lines = [chunk["text"]]
    if chunk["translation"]:
        lines.append(f"Перевод: {chunk['translation']}")
    if chunk["example"]:
        lines.append(f"Пример: {chunk['example']}")
    return "\n".join(lines)


def notifications_view(student):
    def mark(value):
        return "✅" if value else "⬜️"

    keyboard = InlineKeyboardMarkup(
        [
            [InlineKeyboardButton(
                f"{mark(student['notify_chunk'])} Чанк дня с примером",
                callback_data="notify:chunk")],
            [InlineKeyboardButton(
                f"{mark(student['notify_frame'])} Задание «Закончи фразу»",
                callback_data="notify:frame")],
            [InlineKeyboardButton(
                f"{mark(student['notify_train'])} Напоминание о карточках",
                callback_data="notify:train")],
            [InlineKeyboardButton(
                f"🕒 Время: {student['notify_time']}", callback_data="settime")],
        ]
    )
    return "Выбери, что присылать раз в день:", keyboard


# ---------- Вход ----------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data.clear()
    student = db.student_by_telegram(update.effective_user.id)
    if student:
        await update.message.reply_text(
            f"Привет, {student['name']}! Что потренируем?", reply_markup=MENU
        )
    elif is_teacher(update):
        await teacher_help(update, context)
    else:
        await update.message.reply_text("Привет! Введи свой ID от преподавателя.")


async def my_id(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(f"Твой Telegram ID: {update.effective_user.id}")


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data.clear()
    await update.message.reply_text("Отменено.")


# ---------- Преподаватель ----------
async def teacher_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_teacher(update):
        return
    await update.message.reply_text(
        "Команды преподавателя:\n"
        "/addstudent Имя — создать студента и его ID\n"
        "/students — список студентов и их ID\n"
        "/add — добавить лексику\n"
        "/list — посмотреть лексику студента\n"
        "/delete номер — удалить чанк\n"
        "/answers — последние ответы студентов"
    )


async def add_student(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_teacher(update):
        return
    name = " ".join(context.args).strip()
    if not name:
        await update.message.reply_text("Напиши так: /addstudent Анна")
        return
    await update.message.reply_text(f"{name}: ID {db.add_student(name)}")


async def list_students(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_teacher(update):
        return
    rows = db.students()
    if not rows:
        await update.message.reply_text("Студентов пока нет: /addstudent Имя")
        return
    lines = [
        f"{row['name']}: {row['code']} ({'подключён' if row['telegram_id'] else 'не подключён'})"
        for row in rows
    ]
    await update.message.reply_text("\n".join(lines))


def student_picker(prefix, include_all):
    rows = [
        [InlineKeyboardButton(row["name"], callback_data=f"{prefix}:{row['id']}")]
        for row in db.students()
    ]
    if include_all and rows:
        rows.append([InlineKeyboardButton("Всем студентам", callback_data=f"{prefix}:all")])
    return InlineKeyboardMarkup(rows)


async def add_vocabulary(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_teacher(update):
        return
    if not db.students():
        await update.message.reply_text("Сначала создай студента: /addstudent Имя")
        return
    await update.message.reply_text(
        "Кому добавить лексику?", reply_markup=student_picker("addfor", True)
    )


async def list_vocabulary(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_teacher(update):
        return
    if not db.students():
        await update.message.reply_text("Студентов пока нет: /addstudent Имя")
        return
    await update.message.reply_text(
        "Чью лексику показать?", reply_markup=student_picker("listfor", False)
    )


async def delete_vocabulary(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_teacher(update):
        return
    if len(context.args) != 1 or not context.args[0].isdigit():
        await update.message.reply_text("Напиши так: /delete 12. Номера есть в /list")
        return
    deleted = db.delete_chunk(int(context.args[0]))
    await update.message.reply_text("Удалено." if deleted else "Такого номера нет.")


async def show_answers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_teacher(update):
        return
    rows = db.recent_answers()
    if not rows:
        await update.message.reply_text("Ответов пока нет.")
        return
    text = "\n\n".join(
        f"{row['name']}\n{row['frame']}\n→ {row['answer']}" for row in rows
    )
    await update.message.reply_text(text[-4000:])


async def save_vocabulary(update, context):
    rows = parse_chunks(update.message.text)
    if not rows:
        await update.message.reply_text(ADD_FORMAT)
        return
    target = context.user_data.pop("adding_for")
    student_ids = (
        [row["id"] for row in db.students()] if target == "all" else [target]
    )
    for student_id in student_ids:
        for text, translation, example, frame in rows:
            db.add_chunk(student_id, text, translation, example, frame, today())
    await update.message.reply_text(f"Добавлено чанков: {len(rows)}.")


# ---------- Студент ----------
async def send_card(message, student):
    chunk = db.next_card(student["id"], today())
    if chunk is None:
        await message.reply_text("На сегодня карточек нет. Отличная работа! 🎉")
        return
    await message.reply_text(
        chunk["text"],
        reply_markup=InlineKeyboardMarkup(
            [[InlineKeyboardButton("Показать", callback_data=f"show:{chunk['id']}")]]
        ),
    )


async def ask_frame(message, context, chunk):
    context.user_data["awaiting"] = "frame"
    context.user_data["frame"] = chunk["frame"]
    await message.reply_text(f"Закончи фразу о себе:\n\n{chunk['frame']}")


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()

    if is_teacher(update) and "adding_for" in context.user_data:
        await save_vocabulary(update, context)
        return

    student = db.student_by_telegram(update.effective_user.id)
    if student is None:
        name = db.link_student(text, update.effective_user.id)
        if name:
            await update.message.reply_text(
                f"Привет, {name}! Всё готово.", reply_markup=MENU
            )
        else:
            await update.message.reply_text(
                "Не нашёл такой ID. Проверь его или спроси преподавателя."
            )
        return

    if text == CARDS:
        context.user_data.pop("awaiting", None)
        await send_card(update.message, student)
    elif text == FRAMES:
        context.user_data.pop("awaiting", None)
        chunk = db.random_frame(student["id"])
        if chunk:
            await ask_frame(update.message, context, chunk)
        else:
            await update.message.reply_text("Заданий пока нет.")
    elif text == NOTIFICATIONS:
        context.user_data.pop("awaiting", None)
        view_text, keyboard = notifications_view(student)
        await update.message.reply_text(view_text, reply_markup=keyboard)
    elif context.user_data.get("awaiting") == "frame":
        await save_answer(update, context, student, text)
    elif context.user_data.get("awaiting") == "time":
        await save_time(update, context, student, text)
    else:
        await update.message.reply_text("Выбери действие в меню 👇", reply_markup=MENU)


async def save_answer(update, context, student, text):
    frame = context.user_data.pop("frame")
    context.user_data.pop("awaiting")
    db.add_answer(student["id"], frame, text)
    await update.message.reply_text("Записала! Преподаватель увидит твой ответ. ✅")
    if TEACHER_ID:
        try:
            await context.bot.send_message(
                TEACHER_ID, f"{student['name']}\n{frame}\n→ {text}"
            )
        except TelegramError:
            log.exception("Не удалось переслать ответ преподавателю")


async def save_time(update, context, student, text):
    match = re.fullmatch(r"([01]?\d|2[0-3])[:.]([0-5]\d)", text)
    if not match:
        await update.message.reply_text("Напиши время так: 09:30")
        return
    value = f"{int(match[1]):02d}:{match[2]}"
    # Если время сегодня уже прошло, первая рассылка будет завтра.
    passed = value <= now().strftime("%H:%M")
    db.set_notify_time(student["id"], value, today() if passed else None)
    context.user_data.pop("awaiting")
    await update.message.reply_text(f"Готово, буду писать в {value}.")


async def on_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    action, _, value = query.data.partition(":")

    if action in ("addfor", "listfor"):
        if not is_teacher(update):
            return
        target = "all" if value == "all" else int(value)
        if action == "addfor":
            context.user_data["adding_for"] = target
            await query.edit_message_text(ADD_FORMAT)
            return
        rows = db.chunks(target)
        lines = [f"{row['id']}. {row['text']}" for row in rows]
        await query.edit_message_text("\n".join(lines)[:4000] or "Лексики пока нет.")
        return

    student = db.student_by_telegram(update.effective_user.id)
    if student is None:
        return

    if action == "show":
        chunk = db.chunk(int(value), student["id"])
        if chunk:
            await query.edit_message_text(
                card_details(chunk),
                reply_markup=InlineKeyboardMarkup(
                    [[
                        InlineKeyboardButton("🔁 Повторить", callback_data=f"again:{value}"),
                        InlineKeyboardButton("✅ Знаю", callback_data=f"know:{value}"),
                    ]]
                ),
            )
    elif action in ("know", "again"):
        db.review(int(value), student["id"], action == "know", today())
        await query.edit_message_reply_markup(None)
        await send_card(query.message, student)
    elif action == "notify":
        db.toggle_notification(student["id"], value)
        view_text, keyboard = notifications_view(db.student(student["id"]))
        await query.edit_message_text(view_text, reply_markup=keyboard)
    elif action == "settime":
        context.user_data["awaiting"] = "time"
        await query.message.reply_text("Во сколько писать? Например, 09:30")
    elif action == "frame":
        chunk = db.chunk(int(value), student["id"])
        if chunk and chunk["frame"]:
            await ask_frame(query.message, context, chunk)


# ---------- Ежедневные уведомления ----------
async def send_notifications(context: ContextTypes.DEFAULT_TYPE):
    current = now()
    day = current.date().isoformat()
    for student in db.students_to_notify(current.strftime("%H:%M"), day):
        # Отмечаем сразу, чтобы при ошибке не слать повторно каждую минуту.
        db.mark_notified(student["id"], day)
        chat_id = student["telegram_id"]
        try:
            if student["notify_chunk"]:
                chunk = db.next_daily_chunk(student["id"], day)
                if chunk:
                    await context.bot.send_message(
                        chat_id, f"Чанк дня ✨\n\n{card_details(chunk)}"
                    )
            if student["notify_frame"]:
                chunk = db.random_frame(student["id"])
                if chunk:
                    await context.bot.send_message(
                        chat_id,
                        f"Задание дня: закончи фразу о себе\n\n{chunk['frame']}",
                        reply_markup=InlineKeyboardMarkup(
                            [[InlineKeyboardButton(
                                "Ответить", callback_data=f"frame:{chunk['id']}")]]
                        ),
                    )
            if student["notify_train"]:
                due = db.due_count(student["id"], day)
                if due:
                    await context.bot.send_message(
                        chat_id, f"Карточек на сегодня: {due}. Нажми «{CARDS}»."
                    )
        except TelegramError:
            log.exception("Не удалось отправить уведомление студенту %s", student["id"])


def main():
    token = os.getenv("BOT_TOKEN")
    if not token:
        raise SystemExit("Не задан BOT_TOKEN. См. README.md")
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("myid", my_id))
    app.add_handler(CommandHandler("cancel", cancel))
    app.add_handler(CommandHandler("help", teacher_help))
    app.add_handler(CommandHandler("addstudent", add_student))
    app.add_handler(CommandHandler("students", list_students))
    app.add_handler(CommandHandler("add", add_vocabulary))
    app.add_handler(CommandHandler("list", list_vocabulary))
    app.add_handler(CommandHandler("delete", delete_vocabulary))
    app.add_handler(CommandHandler("answers", show_answers))
    app.add_handler(CallbackQueryHandler(on_button))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    app.job_queue.run_repeating(send_notifications, interval=60, first=10)
    app.run_polling()


if __name__ == "__main__":
    main()
