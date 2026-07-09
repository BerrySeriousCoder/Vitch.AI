import { pgTable, uuid, varchar, text, timestamp, integer } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { projects } from "./projects.js";

export const lutAssets = pgTable("lut_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  fileName: varchar("file_name", { length: 500 }).notNull(),
  /** `/uploads/...` URL */
  url: text("url").notNull(),
  format: varchar("format", { length: 32 }).notNull().default("cube"),
  /** LUT_3D_SIZE when known */
  size: integer("size"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
