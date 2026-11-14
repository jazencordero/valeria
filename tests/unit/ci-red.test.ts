import { expect, test } from "vitest";

// Temporary: proves CI turns red on a broken unit test (M1-02). Reverted next commit.
test("deliberately broken", () => {
  expect(1).toBe(2);
});
