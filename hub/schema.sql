-- Kovalenko Creatives hub: one shared D1 database for every project.
-- Who may see what lives in `members`; everything else is scoped by project_id
-- and checked by the Worker on every request.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9-]*' AND length(id) BETWEEN 1 AND 40),
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0
);

-- project_id '*' means every project. Emails are stored lowercase.
-- Roles: owner (everything, every project), core (everything on their project, including the
-- development plan and private payment content), commenter (progress, comments, ideas and
-- updates to read; may comment, add notes and ideas; no plan tab, no private content, no ticks).
CREATE TABLE IF NOT EXISTS members (
  email        TEXT NOT NULL CHECK (email = lower(email)),
  project_id   TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'core', 'commenter')),
  display_name TEXT,
  PRIMARY KEY (email, project_id)
);

-- Owner-authored content shown only to a project's members (for example payment terms).
-- Loaded at setup from files kept outside the repository.
CREATE TABLE IF NOT EXISTS project_private (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  html       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);

CREATE TABLE IF NOT EXISTS tasks (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id             TEXT NOT NULL,
  title          TEXT NOT NULL,
  task_group     TEXT NOT NULL,
  sort_order     REAL NOT NULL DEFAULT 0,
  stopping_point INTEGER,
  completed      INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  completed_date TEXT,
  completed_by   TEXT,
  date_label     TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  text         TEXT NOT NULL,
  author_email TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS notes_project ON notes(project_id, created_at);

CREATE TABLE IF NOT EXISTS comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  author_email TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_project ON comments(project_id, created_at);

CREATE TABLE IF NOT EXISTS ideas (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  author_email TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ideas_project ON ideas(project_id, created_at);

-- items is a JSON array of short strings: one week's bullet list, always read and written whole.
-- author_email without an '@' marks a built-in entry (for example 'build-log').
CREATE TABLE IF NOT EXISTS updates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  week_label   TEXT NOT NULL,
  items        TEXT NOT NULL CHECK (json_valid(items) AND json_type(items) = 'array'),
  notes        TEXT NOT NULL DEFAULT '',
  author_email TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_project ON updates(project_id, created_at);
