import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "editor-core",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
