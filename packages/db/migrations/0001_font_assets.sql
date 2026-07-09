-- Manual migration: font_assets (apply with psql or drizzle-kit push when DATABASE_URL is set)
CREATE TABLE IF NOT EXISTS font_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_name varchar(255) NOT NULL,
  file_name varchar(500) NOT NULL,
  url text NOT NULL,
  format varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS font_assets_project_id_idx ON font_assets(project_id);
