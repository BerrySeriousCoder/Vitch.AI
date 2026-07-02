import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/validators",
      "packages/editor-core",
      "apps/api",
      "apps/web",
    ],
  },
});
