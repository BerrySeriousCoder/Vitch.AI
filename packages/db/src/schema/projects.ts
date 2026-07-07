import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  real,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  /** Full project state — tracks, clips, effects, keyframes */
  data: jsonb("data").notNull().default({}),
  /** Project settings — resolution, fps, etc. */
  settings: jsonb("settings").notNull().default({
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 0,
    backgroundColor: "#000000",
    sampleRate: 44100,
  }),
  /** Thumbnail URL for the project card */
  thumbnailUrl: text("thumbnail_url"),
  /** Duration in seconds (denormalized for quick listing) */
  duration: real("duration").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
