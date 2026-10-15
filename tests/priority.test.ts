import { describe, expect, it } from "vitest";
import { jiraPriorityToLevel, levelToJiraPriority } from "../src/priority.ts";

describe("Jira priority mapping", () => {
  it.each([
    ["Highest", "urgent"],
    ["High", "high"],
    ["Medium", "medium"],
    ["Low", "low"],
    ["Lowest", "low"],
    [" highest ", "urgent"],
  ])("reads the Jira priority %j as the level %s", (name, level) => {
    expect(jiraPriorityToLevel(name)).toBe(level);
  });

  it("reads no level for a custom or missing priority", () => {
    expect(jiraPriorityToLevel("P1")).toBeUndefined();
    expect(jiraPriorityToLevel(undefined)).toBeUndefined();
  });

  it.each([
    ["urgent", "Highest"],
    ["high", "High"],
    ["medium", "Medium"],
    ["low", "Low"],
  ])("writes the level %s as the Jira priority %s", (level, name) => {
    expect(levelToJiraPriority(level)).toBe(name);
  });

  it("writes nothing for a value that is not a level", () => {
    expect(levelToJiraPriority("critical")).toBeUndefined();
    expect(levelToJiraPriority("toString")).toBeUndefined();
  });
});
