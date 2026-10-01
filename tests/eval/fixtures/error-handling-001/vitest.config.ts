import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/gate.test.ts"],
  },
});
