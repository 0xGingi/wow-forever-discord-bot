import { expect, test } from "bun:test";
import { rollRange } from "./commands.ts";

test("rollRange matches WoW /roll semantics", () => {
  expect(rollRange()).toEqual([1, 100]);
  expect(rollRange(50)).toEqual([1, 50]);
  expect(rollRange(20, 10)).toEqual([10, 20]);
  expect(rollRange(10, 20)).toEqual([10, 20]);
  expect(rollRange(1, 1)).toEqual([1, 1]);
});
