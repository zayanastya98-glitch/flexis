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
