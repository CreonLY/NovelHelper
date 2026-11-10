import {
  getDb,
  getOrCreateDefaultProject,
  newId,
  nowIso,
  type CharacterRow,
  type ChapterRow,
  type ThreadRow,
} from "../db";
import { loadModelConfig } from "../config";
import { callStructured, streamChat, type Usage } from "../llm/gateway";
import { assembleDraftContext, assembleOutlineContext, type StoryState } from "./assembler";
import { ChapterOutlineSchema, type ChapterOutline } from "./schemas";
import { finishRun, runStep, startRun, type Emit } from "./loop";

/**
 * Workflow 层 = Service 层的 SOP。
 *
 * 一次"生成一章"被拆成两个 step：
 *   1. outline：结构化输出（JSON 契约 + 校验 + 自修复）
 *   2. draft  ：流式输出（长文本，边生成边落盘）
 *
 * 为什么不在一个 step 里做完：
 *   两个步骤的失败语义完全不同。章纲错了可以重生成，正文写到一半断了要保留。
 *   拆开之后，重试粒度、落盘粒度、计费统计粒度才对得上。
 */

export type GenerateChapterInput = {
  chapterIdx?: number;
  brief?: string;
  tokenBudget?: number;
};

export type GenerateChapterResult = {
  runId: string;
  chapterId: string;
  chapterIdx: number;
  words: number;
};

function countWords(text: string): number {
  // 中文场景下，"去掉空白后的字符数"比空格分词更接近读者的字数直觉
  return text.replace(/\s/g, "").length;
}

function loadStoryState(projectId: string, nextIdx: number): StoryState {
  const db = getDb();
  const project = getOrCreateDefaultProject();

  const characters = db
    .prepare("SELECT * FROM characters WHERE project_id = ? ORDER BY role, name")
    .all(projectId) as CharacterRow[];

  const openThreads = db
    .prepare("SELECT * FROM threads WHERE project_id = ? AND status = 'open' ORDER BY id")
    .all(projectId) as ThreadRow[];

  const prev = db
    .prepare(
      `SELECT content FROM chapters
       WHERE project_id = ? AND idx < ? AND length(content) > 0
       ORDER BY idx DESC LIMIT 1`,
    )
    .get(projectId, nextIdx) as { content: string } | undefined;

  return {
    project,
    characters: characters.map((c) => ({ ...c })),
    openThreads: openThreads.map((t) => ({ ...t })),
    previousTail: prev?.content ? prev.content.slice(-1600) : "",
    nextIdx,
  };
}

function nextChapterIdx(projectId: string): number {
  const row = getDb()
    .prepare("SELECT MAX(idx) AS m FROM chapters WHERE project_id = ?")
    .get(projectId) as { m: number | null } | undefined;
  return (row?.m ?? 0) + 1;
}

function upsertChapter(args: {
  projectId: string;
  idx: number;
  patch: Partial<Pick<ChapterRow, "title" | "outline" | "content" | "word_count" | "status">>;
}): string {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM chapters WHERE project_id = ? AND idx = ?")
    .get(args.projectId, args.idx) as ChapterRow | undefined;

  if (!existing) {
    const id = newId("ch");
    const ts = nowIso();
    db.prepare(
      `INSERT INTO chapters (id, project_id, idx, title, outline, content, word_count, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      args.projectId,
      args.idx,
      args.patch.title ?? "",
      args.patch.outline ?? "{}",
      args.patch.content ?? "",
      args.patch.word_count ?? 0,
      args.patch.status ?? "draft",
      ts,
      ts,
    );
    return id;
  }

  db.prepare(
    `UPDATE chapters SET title = ?, outline = ?, content = ?, word_count = ?, status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    args.patch.title ?? existing.title,
    args.patch.outline ?? existing.outline,
    args.patch.content ?? existing.content,
    args.patch.word_count ?? existing.word_count,
    args.patch.status ?? existing.status,
    nowIso(),
    existing.id,
  );
  return existing.id;
}

/**
 * 章纲 → 线索表。纯确定性写入。
 *
 * 这一步是整个系统"不丢伏笔"的根据地：模型只在章纲里声明"我要埋什么、收什么"，
 * 真正的记账由代码完成。模型永远没有权限直接改线索状态。
 */
function applyThreads(projectId: string, idx: number, outline: ChapterOutline): void {
  const db = getDb();
  const ts = nowIso();

  for (const title of outline.threadsToPlant) {
    const t = title.trim();
    if (!t) continue;
    db.prepare(
      `INSERT INTO threads (id, project_id, type, title, detail, planted_chapter, planned_payoff_ch, actual_payoff_ch, status, updated_at)
       VALUES (?, ?, 'foreshadow', ?, ?, ?, NULL, NULL, 'open', ?)`,
    ).run(newId("th"), projectId, t, `第 ${idx} 章埋设`, idx, ts);
  }

  for (const title of outline.threadsToPayoff) {
    const t = title.trim();
    if (!t) continue;
    // 精确匹配标题；匹配不到就静默跳过——宁可漏记，也不要凭模糊匹配写错状态
    db.prepare(
      `UPDATE threads SET status = 'paid', actual_payoff_ch = ?, updated_at = ?
       WHERE project_id = ? AND title = ? AND status = 'open'`,
    ).run(idx, ts, projectId, t);
  }
}

export async function generateChapter(
  input: GenerateChapterInput,
  emit: Emit,
): Promise<GenerateChapterResult> {
  const cfg = loadModelConfig();
  const project = getOrCreateDefaultProject();
  const idx = input.chapterIdx ?? nextChapterIdx(project.id);
  const budget = input.tokenBudget ?? 12_000;

  const runId = startRun(project.id, "generate-chapter", { idx, brief: input.brief ?? "" });
  emit({ type: "run", runId, chapterIdx: idx });

  const state = loadStoryState(project.id, idx);
  let chapterId = "";
  let usageTotal: Usage = { promptTokens: 0, completionTokens: 0 };

  try {
    // ── Step 1：章纲（结构化输出 + 契约校验） ────────────────────────────
    const outline = await runStep<ChapterOutline>({
      runId,
      seq: 1,
      name: "outline",
      emit,
      fn: async (stepId) => {
        const ctx = assembleOutlineContext(state, input.brief ?? "", budget);
        emit({
          type: "context",
          step: "outline",
          sections: ctx.sections,
          totalTokens: ctx.totalTokens,
          budget: ctx.budget,
        });
        const res = await callStructured({
          cfg,
          messages: ctx.messages,
          schema: ChapterOutlineSchema,
          runId,
          stepId,
        });
        usageTotal = {
          promptTokens: usageTotal.promptTokens + res.usage.promptTokens,
          completionTokens: usageTotal.completionTokens + res.usage.completionTokens,
        };
        return res.data;
      },
    });

    chapterId = upsertChapter({
      projectId: project.id,
      idx,
      patch: {
        title: outline.title,
        outline: JSON.stringify(outline),
        status: "outlined",
      },
    });
    applyThreads(project.id, idx, outline);
    emit({ type: "outline", data: outline, chapterId });

    // ── Step 2：正文（流式） ────────────────────────────────────────────
    let text = "";
    await runStep<void>({
      runId,
      seq: 2,
      name: "draft",
      emit,
      fn: async (stepId) => {
        const ctx = assembleDraftContext(state, outline, budget);
        emit({
          type: "context",
          step: "draft",
          sections: ctx.sections,
          totalTokens: ctx.totalTokens,
          budget: ctx.budget,
        });

        for await (const ev of streamChat(cfg, ctx.messages, { runId, stepId })) {
          if (ev.type === "delta") {
            text += ev.text;
            emit({ type: "delta", text: ev.text });
          } else {
            usageTotal = {
              promptTokens: usageTotal.promptTokens + ev.usage.promptTokens,
              completionTokens: usageTotal.completionTokens + ev.usage.completionTokens,
            };
            emit({ type: "usage", usage: ev.usage });
          }
        }
      },
    });

    const words = countWords(text);
    upsertChapter({
      projectId: project.id,
      idx,
      patch: { content: text, word_count: words, status: "drafted" },
    });

    finishRun(runId, "done", { chapterId, idx, words });
    emit({ type: "done", chapterId, chapterIdx: idx, words, usage: usageTotal });

    return { runId, chapterId, chapterIdx: idx, words };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishRun(runId, "failed", { chapterId, idx }, message);
    throw err;
  }
}
