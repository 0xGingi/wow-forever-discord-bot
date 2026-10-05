import { expect, test } from "bun:test";
import { addDaysLocal, parseWhen, whenChoices, zoneChoices } from "./time.ts";

const NOW = Date.parse("2026-10-05T22:30:00Z"); // Mon 6:30pm in New York, Tue 9:30am in Sydney
const at = (s: string, tz: string | null) => {
  const r = parseWhen(s, tz, NOW);
  return "at" in r ? new Date(r.at * 1000).toISOString() : r.error;
};

test("reads times in the person's own timezone", () => {
  expect(at("friday 8pm", "America/New_York")).toBe("2026-10-10T00:00:00.000Z"); // EDT
  expect(at("tomorrow 20:00", "America/New_York")).toBe("2026-10-07T00:00:00.000Z");
  expect(at("nov 10 7:30pm", "America/New_York")).toBe("2026-11-11T00:30:00.000Z"); // EST by then
  expect(at("friday 20:00", "Europe/Berlin")).toBe("2026-10-09T18:00:00.000Z");
  expect(at("tomorrow 8pm", "Australia/Sydney")).toBe("2026-10-07T09:00:00.000Z"); // Sydney is already on Tuesday
});

test("relative and explicit-zone input don't need a saved timezone", () => {
  expect(at("in 2 hours", null)).toBe("2026-10-06T00:30:00.000Z");
  expect(at("in 2 hours", "Australia/Sydney")).toBe("2026-10-06T00:30:00.000Z");
  expect(at("friday 8pm CET", null)).toBe("2026-10-09T18:00:00.000Z");
  expect(at("1793000000", null)).toBe(new Date(1793000000 * 1000).toISOString());
});

test("explains what's wrong", () => {
  expect(at("friday 8pm", null)).toContain("/timezone");
  expect(at("saturday", "America/New_York")).toContain("Add a time");
  expect(at("blorp", "America/New_York")).toContain("Couldn't read");
});

test("weekly repeat keeps wall-clock time across DST and month ends", () => {
  const ny = "America/New_York";
  const t = (s: string) => (parseWhen(s, ny, NOW) as { at: number }).at;
  expect(addDaysLocal(t("oct 29 8pm"), 7, ny)).toBe(t("nov 5 8pm")); // EDT → EST
  expect(addDaysLocal(t("dec 28 8pm"), 14, ny)).toBe(t("jan 11 2027 8pm"));
});

test("autocomplete previews and suggestions", () => {
  expect(whenChoices("friday 8pm", "America/New_York", NOW)[0]!.name).toBe("Fri, Oct 9, 8:00 PM EDT · in 4 days");
  expect(whenChoices("", "America/New_York", NOW).length).toBe(8); // 6:30pm now, so tonight 8pm counts
  expect(zoneChoices("new york", NOW)[0]!.value).toBe("America/New_York");
  expect(zoneChoices("6:30 PM", NOW).some((c) => c.value === "America/New_York")).toBe(true);
});
