const HOUR = 3_600_000;
const at9 = (day: Date): number =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0, 0, 0).getTime();

/** The menu's snooze times in the device's local time (M4R100). */
export function snoozeTimes(now: Date): { hour: number; tomorrow: number; nextWeek: number } {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  // getDay(): 0 Sunday … 6 Saturday. Days until the next Monday, a full week when today is Monday.
  const toMonday = (8 - now.getDay()) % 7 || 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + toMonday);
  return { hour: now.getTime() + HOUR, tomorrow: at9(tomorrow), nextWeek: at9(monday) };
}

const two = (value: number): string => String(value).padStart(2, "0");

/** A time as the local `YYYY-MM-DDTHH:mm` value of a `datetime-local` field. */
export function toLocalInput(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}
