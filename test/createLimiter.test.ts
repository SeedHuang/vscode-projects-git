import { describe, it, expect } from "vitest";
import { createLimiter } from "../src/util/createLimiter";

describe("createLimiter", () => {
  it("并发不超过上限", async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    };
    await Promise.all(Array.from({ length: 10 }, () => limit(task)));
    expect(peak).toBe(3);
  });

  it("结果与错误都正常传递", async () => {
    const limit = createLimiter(2);
    const v = await limit(async () => 42);
    expect(v).toBe(42);
    await expect(limit(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});