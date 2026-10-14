import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The suites use the jest-style globals (describe/it/expect).
    globals: true,
  },
});
