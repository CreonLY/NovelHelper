import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 存储层：单文件 SQLite。
 *
 * 为什么不用 Postgres / Prisma：
 *   单机 MVP 的并发量是 1 个用户、1 个写进程，SQLite 的 WAL 模式完全够用，
 *   而零运维、零迁移工具、库文件可直接备份，对个人开发者的性价比最高。
 *   升级路径：把本文件替换成 Prisma/Kysely 适配层即可，SQL 本身是标准 SQL。
 */

const SCHEMA = `
-- 键值配置：模型网关地址、密钥、温度等运行期参数
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 作品：一次创作对应一条（MVP 里固定只有一条，但表结构预留多作品）
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  premise      TEXT NOT NULL DEFAULT '',
  style_sample TEXT NOT NULL DEFAULT '',
  genre        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 人物卡 = 状态机的“状态”。knows / doesnt_know 是可校验的信息边界。
CREATE TABLE IF NOT EXISTS characters (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'supporting',
  goal         TEXT NOT NULL DEFAULT '',
  knows        TEXT NOT NULL DEFAULT '[]',
  doesnt_know  TEXT NOT NULL DEFAULT '[]',
  constraints  TEXT NOT NULL DEFAULT '[]',
  state        TEXT NOT NULL DEFAULT '{}',
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id);

-- 线索表：明线 / 支线 / 伏笔。status + 计划回收章 → 逾期告警是纯 SQL。
CREATE TABLE IF NOT EXISTS threads (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  type               TEXT NOT NULL DEFAULT 'foreshadow',
  title              TEXT NOT NULL,
  detail             TEXT NOT NULL DEFAULT '',
  planted_chapter    INTEGER,
  planned_payoff_ch  INTEGER,
  actual_payoff_ch   INTEGER,
  status             TEXT NOT NULL DEFAULT 'open',
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id, status);

-- 章节：章纲（JSON）与正文（TEXT）。status 就是审批门禁。
CREATE TABLE IF NOT EXISTS chapters (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  outline     TEXT NOT NULL DEFAULT '{}',
  content     TEXT NOT NULL DEFAULT '',
  word_count  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chapters_project_idx ON chapters(project_id, idx);

-- Run = 一次任务实例（类比一个数据库事务上下文）
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',
  input       TEXT NOT NULL DEFAULT '{}',
  output      TEXT NOT NULL DEFAULT '{}',
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Step = Run 内的一个节点。落盘后支持断点续跑与回放。
CREATE TABLE IF NOT EXISTS steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',
  input       TEXT NOT NULL DEFAULT '{}',
  output      TEXT NOT NULL DEFAULT '{}',
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, seq);

-- 调用账本：每一次模型调用都记账，这是成本可观测与故障定位的地基
CREATE TABLE IF NOT EXISTS llm_calls (
  id                TEXT PRIMARY KEY,
  run_id            TEXT,
  step_id           TEXT,
  base_url          TEXT NOT NULL DEFAULT '',
  model             TEXT NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'ok',
  error             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id);
`;

declare global {
  // eslint-disable-next-line no-var
  var __novelHelperDb: DatabaseSync | undefined;
}

export function getDb(): DatabaseSync {
  if (globalThis.__novelHelperDb) return globalThis.__novelHelperDb;

  const dataDir =
    process.env.NOVELHELPER_DATA_DIR ?? path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, "novel.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  globalThis.__novelHelperDb = db;
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowIso());
}

export type ProjectRow = {
  id: string;
  title: string;
  premise: string;
  style_sample: string;
  genre: string;
  created_at: string;
  updated_at: string;
};

export type CharacterRow = {
  id: string;
  project_id: string;
  name: string;
  role: string;
  goal: string;
  knows: string;
  doesnt_know: string;
  constraints: string;
  state: string;
  updated_at: string;
};

export type ThreadRow = {
  id: string;
  project_id: string;
  type: string;
  title: string;
  detail: string;
  planted_chapter: number | null;
  planned_payoff_ch: number | null;
  actual_payoff_ch: number | null;
  status: string;
  updated_at: string;
};

export type ChapterRow = {
  id: string;
  project_id: string;
  idx: number;
  title: string;
  outline: string;
  content: string;
  word_count: number;
  status: string;
  created_at: string;
  updated_at: string;
};

export function getOrCreateDefaultProject(): ProjectRow {
  const db = getDb();
  const found = db
    .prepare("SELECT * FROM projects ORDER BY created_at ASC LIMIT 1")
    .get() as ProjectRow | undefined;
  if (found) return found;

  const id = "p_default";
  const ts = nowIso();
  db.prepare(
    `INSERT INTO projects (id, title, premise, style_sample, genre, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "未命名作品", "", "", "", ts, ts);

  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow;
}

export function updateProject(
  id: string,
  patch: Partial<Pick<ProjectRow, "title" | "premise" | "style_sample" | "genre">>,
): void {
  const current = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as ProjectRow | undefined;
  if (!current) return;

  getDb()
    .prepare(
      `UPDATE projects SET title = ?, premise = ?, style_sample = ?, genre = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.title ?? current.title,
      patch.premise ?? current.premise,
      patch.style_sample ?? current.style_sample,
      patch.genre ?? current.genre,
      nowIso(),
      id,
    );
}
