import * as chrono from "chrono-node";

export const ZONES = Intl.supportedValuesOf("timeZone");
const POPULAR = [
  "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Halifax", "America/Sao_Paulo",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Helsinki", "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata",
  "Asia/Singapore", "Asia/Tokyo", "Australia/Perth", "Australia/Sydney", "Pacific/Auckland",
];

const localParts = (unix: number, tz: string): Record<string, number> =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(unix * 1000)
      .map((x) => [x.type, Number(x.value)]),
  );

// ponytail: a wall-clock time inside a DST gap/overlap resolves one way silently; nobody raids at 2am on switch night.
export function localToUnix(y: number, mo: number, d: number, h: number, mi: number, tz: string) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const p = localParts(naive / 1000, tz);
  return (naive - (Date.UTC(p.year!, p.month! - 1, p.day, p.hour, p.minute) - naive)) / 1000;
}

/** Same wall-clock time `days` later, so a weekly 8pm raid stays 8pm across DST. */
export function addDaysLocal(unix: number, days: number, tz: string) {
  const p = localParts(unix, tz);
  return localToUnix(p.year!, p.month!, p.day! + days, p.hour!, p.minute!, tz);
}

/**
 * "friday 8pm", "tomorrow 20:00", "nov 10 7:30pm", "in 2 hours", "sat 9pm CET", or a unix timestamp.
 * Read in `tz` (the person's saved zone) unless the text names its own zone.
 */
export function parseWhen(input: string, tz: string | null, now = Date.now()): { at: number } | { error: string } {
  const s = input.trim();
  if (/^\d{10}$/.test(s)) return { at: Number(s) };
  // chrono can't take IANA zones, so feed it the wall clock in `tz` as a plain Date and convert its answer back.
  const p = localParts(Math.floor(now / 1000), tz ?? "UTC");
  const ref = new Date(p.year!, p.month! - 1, p.day, p.hour, p.minute, p.second);
  const r = chrono.parse(s, ref, { forwardDate: true })[0];
  if (!r) return { error: "Couldn't read that. Try `friday 8pm`, `tomorrow 20:00` or `nov 10 7:30pm`." };
  if (r.start.tags().has("result/relativeDate")) return { at: Math.round(now / 1000 + (r.start.date().getTime() - ref.getTime()) / 1000) };
  if (!r.start.isCertain("hour")) return { error: `Add a time too, e.g. \`${r.text} 8pm\`.` };
  const [y, mo, d, h, mi] = (["year", "month", "day", "hour", "minute"] as const).map((k) => r.start.get(k)!) as [number, number, number, number, number];
  if (r.start.isCertain("timezoneOffset")) return { at: (Date.UTC(y, mo - 1, d, h, mi) - r.start.get("timezoneOffset")! * 60_000) / 1000 };
  if (!tz) return { error: "Set your timezone first with `/timezone`, or include one, like `friday 8pm EST`." };
  return { at: localToUnix(y, mo, d, h, mi, tz) };
}

export const fmtTime = (unix: number, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
    .format(unix * 1000);

const fromNow = (unix: number, now: number) => {
  const h = (unix - now / 1000) / 3600;
  if (h < 0) return "in the past";
  if (h < 1) return `in ${Math.round(h * 60)} min`;
  if (h < 48) return `in ${Math.round(h)}h`;
  return `in ${Math.round(h / 24)} days`;
};

/** Autocomplete for a `when` option: a live preview of what was typed, or the next week of 8pm slots. */
export function whenChoices(q: string, tz: string | null, now = Date.now()) {
  if (!q.trim()) {
    if (!tz) return [{ name: "Type a time with a zone, e.g. friday 8pm EST (or set /timezone)", value: "friday 8pm" }];
    const p = localParts(Math.floor(now / 1000), tz);
    return Array.from({ length: 8 }, (_, d) => localToUnix(p.year!, p.month!, p.day! + d, 20, 0, tz))
      .filter((at) => at > now / 1000)
      .map((at) => ({ name: `${fmtTime(at, tz)} · ${fromNow(at, now)}`, value: String(at) }));
  }
  const r = parseWhen(q, tz, now);
  if ("error" in r) return [{ name: r.error.replace(/`/g, "").slice(0, 100), value: q.slice(0, 100) }];
  return [{ name: `${fmtTime(r.at, tz ?? "UTC")} · ${fromNow(r.at, now)}`.slice(0, 100), value: String(r.at) }];
}

/** Autocomplete for /timezone: search by city, region, zone name or the current local time. */
export function zoneChoices(q: string, now = Date.now()) {
  const label = (z: string) => {
    const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: z, ...o }).format(now);
    const name = f({ timeZoneName: "long" }).split(", ")[1] ?? "";
    return `${z.replace(/_/g, " ")} · ${f({ hour: "numeric", minute: "2-digit" })} now · ${name}`.slice(0, 100);
  };
  const needle = q.toLowerCase().replace(/_/g, " ");
  const list = needle
    ? ZONES.map((z) => ({ z, l: label(z) })).filter((x) => x.l.toLowerCase().includes(needle)).sort((a, b) => +!POPULAR.includes(a.z) - +!POPULAR.includes(b.z))
    : POPULAR.map((z) => ({ z, l: label(z) }));
  return list.slice(0, 25).map((x) => ({ name: x.l, value: x.z }));
}
