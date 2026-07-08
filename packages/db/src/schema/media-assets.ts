import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  real,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { projects } from "./projects.js";

export const mediaTypeEnum = pgEnum("media_type", [
  "video",
  "audio",
  "image",
]);

export const uploadStatusEnum = pgEnum("upload_status", [
  "pending",
  "uploading",
  "processing",
  "ready",
  "error",
]);

export const mediaAssets = pgTable("media_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 500 }).notNull(),
  type: mediaTypeEnum("type").notNull(),
  /** Original file URL */
  url: text("url").notNull(),
  /** Generated thumbnail */
  thumbnailUrl: text("thumbnail_url"),
  /** Low-res proxy for preview playback */
  proxyUrl: text("proxy_url"),
  /** Waveform data URL (for audio tracks) */
  waveformUrl: text("waveform_url"),
  /** File metadata — dimensions, duration, codec, etc. */
  metadata: jsonb("metadata").notNull().default({}),
  status: uploadStatusEnum("status").notNull().default("pending"),
  /** File size in bytes */
  fileSize: integer("file_size").notNull().default(0),
  /** Duration in seconds (for video/audio) */
  duration: real("duration"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
