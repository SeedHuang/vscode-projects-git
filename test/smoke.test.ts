import { describe, it, expect } from "vitest";

describe("冒烟", () => {
  it("测试环境可用", () => {
    expect(1 + 1).toBe(2);
  });
});