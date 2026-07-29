import { describe, expect, it } from "vitest";
import { formatDate } from "./client";

describe("formatDate", () => {
  it("formats an ISO timestamp in zh-CN style", () => {
    expect(formatDate("2026-01-05T08:30:00Z")).toMatch(/\d{2}\/\d{2}/);
  });

  it("returns empty string for missing values", () => {
    expect(formatDate(undefined)).toBe("");
    expect(formatDate("")).toBe("");
  });
});
