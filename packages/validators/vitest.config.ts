import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "validators",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
