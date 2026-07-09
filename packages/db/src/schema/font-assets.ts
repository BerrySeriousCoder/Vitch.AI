import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { projects } from "./projects.js";

export const fontAssets = pgTable("font_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** CSS family name registered via FontFace */
  familyName: varchar("family_name", { length: 255 }).notNull(),
  fileName: varchar("file_name", { length: 500 }).notNull(),
  /** `/uploads/...` URL */
  url: text("url").notNull(),
  format: varchar("format", { length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
