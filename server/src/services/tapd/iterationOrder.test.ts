import assert from "node:assert/strict";
import { test } from "node:test";
import { sortIterations } from "./iterationOrder.js";

test("iteration names from the picker sort by date descending, including month-only names", () => {
  const names = ["2026年10月23日", "2026年12月16日版本", "2026年11月13日", "【研发-产权】2026年10月", "2026年9月23日（清远专区）", "2026年10月19号", "产权一期需求（2026年9月8日）", "2026年10月30号"];
  const iterations = names.map((name, index) => ({ id: String(index), name }));
  assert.deepEqual(sortIterations(iterations).map(item => item.name), [
    names[1], names[2], names[7], names[0], names[5], names[3], names[4], names[6],
  ]);
  assert.deepEqual(iterations.map(item => item.name), names);
});

test("missing name dates fall back to end/start dates; invalid and undated entries sort last stably", () => {
  const iterations = [
    { id: "undated1", name: "待规划" },
    { id: "start", name: "下一期", startdate: "2026-11-01" },
    { id: "invalid", name: "2026年2月30日", enddate: "0000-00-00" },
    { id: "end", name: "本期", startdate: "2026-09-01", enddate: "2026-12-01" },
    { id: "named", name: "2027/1/2版本", enddate: "2026-10-01" },
    { id: "same", name: "2026.11.01" },
    { id: "undated2", name: "未排期", startdate: "invalid" },
  ];
  assert.deepEqual(sortIterations(iterations).map(item => item.id), ["named", "end", "start", "same", "undated1", "invalid", "undated2"]);
});
