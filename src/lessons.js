// Расписание и напоминания об уроках. Чистые функции: без базы и без Telegram.

export const REMIND_BEFORE = 5;

// Названия дней по индексу getUTCDay: 0 — воскресенье.
export const DAY_NAMES = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

const DAYS = Object.fromEntries(DAY_NAMES.map((name, index) => [name, index]));

// «вт 16:00, пт 16:00» → [{weekday: 2, time: "16:00"}, {weekday: 5, time: "16:00"}]; null, если формат не понятен.
export function parseSchedule(text) {
  const parts = text
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  const slots = [];
  for (const part of parts) {
    const match = part.match(/^([а-я]{2})\s+(\d{1,2}):(\d{2})$/);
    if (!match || !(match[1] in DAYS)) return null;
    const hour = Number(match[2]);
    const minute = Number(match[3]);
    if (hour > 23 || minute > 59) return null;
    slots.push({
      weekday: DAYS[match[1]],
      time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    });
  }
  return slots;
}

export function minutesOf(time) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

// Слоты, о которых пора напомнить: от REMIND_BEFORE минут до начала урока и до самого начала.
export function dueReminders(slots, date, time) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const now = minutesOf(time);
  return slots
    .filter((slot) => slot.weekday === weekday)
    .filter((slot) => {
      const start = minutesOf(slot.time);
      return now >= start - REMIND_BEFORE && now < start;
    });
}

// Дата плюс несколько дней, в формате ГГГГ-ММ-ДД.
export function addDays(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

// Пора ли напомнить об уроке, который начинается в start, если сейчас now.
export function inReminderWindow(start, now) {
  const begin = minutesOf(start);
  const current = minutesOf(now);
  return current >= begin - REMIND_BEFORE && current < begin;
}

// Все уроки по расписанию на ближайшие days дней, начиная с from.
export function upcomingOccurrences(slots, from, days) {
  const occurrences = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(from, offset);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    for (const slot of slots) {
      if (slot.weekday === weekday) occurrences.push({ date, time: slot.time });
    }
  }
  return occurrences;
}

// «05.11 18:00» → {date: "2026-11-05", time: "18:00"}; null, если формат не понятен.
export function parseMove(text, year) {
  const match = text.trim().match(/^(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [day, month, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (new Date(`${date}T00:00:00Z`).getUTCDate() !== day) return null;
  return { date, time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

// Подпись урока для кнопок и сообщений: «05.11 (чт) 18:00».
export function lessonLabel(date, time) {
  const [, month, day] = date.split("-");
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return `${day}.${month} (${DAY_NAMES[weekday]}) ${time}`;
}
