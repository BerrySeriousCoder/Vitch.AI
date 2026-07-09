import { defineConfig } from "vitest/config";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export default defineConfig({
  test: {
    name: "api",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    fileParallelism: false,
  },
});
