import { expect, test } from "bun:test";
import { isFull, slotBlocked, toPromote } from "./events.ts";
import { formatCharName } from "./game.ts";
import type { Signup } from "./db.ts";

const s = (user_id: string, role: string, status: Signup["status"] = "in"): Signup => ({ event_id: 1, user_id, status, role, char_name: user_id });

test("lfg caps roles at 1/1/3, raids don't", () => {
  const lfg = { kind: "lfg" } as const;
  expect(slotBlocked(lfg, [s("a", "Tank")], "b", "Tank")).toBeTruthy();
  expect(slotBlocked(lfg, [s("a", "Tank")], "a", "Tank")).toBeNull(); // re-clicking own slot
  expect(slotBlocked(lfg, [s("a", "DPS"), s("b", "DPS")], "c", "DPS")).toBeNull();
  expect(slotBlocked(lfg, [s("a", "DPS"), s("b", "DPS"), s("c", "DPS")], "d", "DPS")).toBeTruthy();
  expect(slotBlocked({ kind: "raid" }, [s("a", "Tank"), s("b", "Tank")], "c", "Tank")).toBeNull();
});

test("raid size: full ignores bench/tentative and yourself", () => {
  const raid = { size: 2 };
  expect(isFull(raid, [s("a", "DPS"), s("b", "Healer", "tentative"), s("c", "DPS", "bench")], "d")).toBe(false);
  expect(isFull(raid, [s("a", "DPS"), s("b", "Healer")], "c")).toBe(true);
  expect(isFull(raid, [s("a", "DPS"), s("b", "Healer")], "a")).toBe(false); // role swap
  expect(isFull({ size: null }, [s("a", "DPS"), s("b", "DPS")], "c")).toBe(false);
});

test("bench promotes oldest first, only into open spots", () => {
  const signups = [s("a", "DPS"), s("b", "Tank", "bench"), s("c", "DPS", "tentative"), s("d", "Healer", "bench")];
  expect(toPromote({ size: 2 }, signups).map((x) => x.user_id)).toEqual(["b"]);
  expect(toPromote({ size: 5 }, signups).map((x) => x.user_id)).toEqual(["b", "d"]);
  expect(toPromote({ size: 1 }, signups)).toEqual([]);
  expect(toPromote({ size: null }, signups)).toEqual([]);
});

test("Forever names are first + second, capitalized, letters only", () => {
  expect(formatCharName("asha", "BRIGHTVALE")).toBe("Asha Brightvale");
  expect(formatCharName(" Thalen ", "Brightvale")).toBe("Thalen Brightvale");
  expect(formatCharName("Zoë", "Ælfwine")).toBe("Zoë Ælfwine"); // accented letters are fine
  expect(formatCharName("Averyveryverylongfirstname", "Brightvale")).toBeNull(); // 26 letters
  expect(formatCharName("Asha", "")).toBeNull();
  expect(formatCharName("Asha", "Bright vale")).toBeNull();
  expect(formatCharName("A5ha", "Brightvale")).toBeNull();
});
