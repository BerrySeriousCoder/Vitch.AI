import {
  pgTable,
  pgEnum,
  uuid,
  text,
  real,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { projects } from "./projects.js";

export const renderStatusEnum = pgEnum("render_status", [
  "queued",
  "processing",
  "encoding",
  "uploading",
  "completed",
  "failed",
]);

export const renderJobs = pgTable("render_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  status: renderStatusEnum("status").notNull().default("queued"),
  /** Progress 0-100 */
  progress: real("progress").notNull().default(0),
  /** Export settings (format, codec, resolution, etc.) */
  settings: jsonb("settings").notNull().default({}),
  /** URL to the rendered output */
  outputUrl: text("output_url"),
  /** Error message if failed */
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
