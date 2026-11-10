import type { ChatMessage } from "../llm/gateway";
import { estimateTokens } from "../llm/gateway";
import type { CharacterRow, ProjectRow, ThreadRow } from "../db";
import type { ChapterOutline } from "./schemas";
import { loadConstitution, loadDraftSkill, loadOutlineSkill } from "./prompts";

/**
 * Context Assembler —— 全书最核心的 200 行。
 *
 * 它解决一个问题：把"一个 200 万字的故事"压缩成"一次调用能装下的 1 万 token"。
 * 类比后端：不是把整张表 SELECT * 进内存，而是先做 projection + 索引 + 缓存。
 *
 * 分层（从稳定到易变）：
 *   L0 宪章/规则   —— 永不变，常驻 system
 *   L1 结构化状态  —— 人物卡、线索表，来自 SQLite，权威事实
 *   L2 风格样本    —— 决定"怎么写"，可裁剪
 *   L3 局部上下文  —— 前文结尾 + 本章章纲，最易变
 * 预算超了，从 L2 开始砍：它是"锦上添花"，L1 砍了会崩人设。
 */

export const DEFAULT_TOKEN_BUDGET = 12_000;

const OPTIONAL_SHARE = 0.35;

export type StoryState = {
  project: ProjectRow;
  characters: CharacterRow[];
  openThreads: ThreadRow[];
  previousTail: string;
  nextIdx: number;
};

export type ContextSection = {
  name: string;
  chars: number;
  tokens: number;
  optional: boolean;
};

export type Assembled = {
  messages: ChatMessage[];
  sections: ContextSection[];
  totalTokens: number;
  budget: number;
};

type Sec = { name: string; content: string; optional?: boolean };

function parseList(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（此处截断）`;
}

function renderCharacters(characters: CharacterRow[]): string {
  if (characters.length === 0) {
    return "（尚未建立人物档案。本章只能使用【本章要求】里点名的角色，并在 assumptions 中说明。）";
  }
  return characters
    .map((c) => {
      const knows = parseList(c.knows);
      const doesnt = parseList(c.doesnt_know);
      const constraints = parseList(c.constraints);
      const lines = [`### ${c.name}（${c.role}）`];
      if (c.goal) lines.push(`- 当前目标：${c.goal}`);
      if (knows.length) lines.push(`- 已知：${knows.join("；")}`);
      if (doesnt.length) lines.push(`- 不知道（重要）：${doesnt.join("；")}`);
      if (constraints.length) lines.push(`- 行为铁律：${constraints.join("；")}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function renderThreads(threads: ThreadRow[], nextIdx: number): string {
  if (threads.length === 0) return "（暂无未回收线索。）";
  return threads
    .map((t) => {
      const overdue =
        t.planned_payoff_ch !== null && t.planned_payoff_ch < nextIdx ? "【已逾期】" : "";
      const meta = [
        t.type === "main" ? "主线" : t.type === "sub" ? "支线" : "伏笔",
        t.planted_chapter !== null ? `埋于第 ${t.planted_chapter} 章` : null,
        t.planned_payoff_ch !== null ? `计划第 ${t.planned_payoff_ch} 章回收` : null,
      ]
        .filter(Boolean)
        .join(" / ");
      return `- ${overdue}「${t.title}」（${meta}）${t.detail ? `：${t.detail}` : ""}`;
    })
    .join("\n");
}

function toSections(sections: Sec[]): ContextSection[] {
  return sections
    .filter((s) => s.content.trim().length > 0)
    .map((s) => ({
      name: s.name,
      chars: s.content.length,
      tokens: estimateTokens(s.content),
      optional: s.optional ?? false,
    }));
}

/**
 * 预算控制：只有 optional 段会被裁剪，且从最大的开始裁。
 * 确定性、可预测——不要指望"模型自己忽略无关信息"，它不会。
 */
function fitBudget(sections: Sec[], budget: number): Sec[] {
  const total = () => sections.reduce((sum, s) => sum + estimateTokens(s.content), 0);
  if (total() <= budget) return sections;

  const working = sections.map((s) => ({ ...s }));
  const optionalBudget = Math.max(200, budget * OPTIONAL_SHARE);
  let optionalTotal = working
    .filter((s) => s.optional)
    .reduce((sum, s) => sum + estimateTokens(s.content), 0);

  while (optionalTotal > optionalBudget) {
    const target = working
      .filter((s) => s.optional && s.content.length > 80)
      .sort((a, b) => b.content.length - a.content.length)[0];
    if (!target) break;
    target.content = clip(target.content, Math.floor(target.content.length * 0.6));
    optionalTotal = working
      .filter((s) => s.optional)
      .reduce((sum, s) => sum + estimateTokens(s.content), 0);
  }
  return working;
}

function build(
  systemParts: string[],
  sections: Sec[],
  budget: number,
): Assembled {
  const fitted = fitBudget(sections, budget);
  const userBody = fitted
    .filter((s) => s.content.trim().length > 0)
    .map((s) => `## ${s.name}\n${s.content}`)
    .join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemParts.join("\n\n---\n\n") },
    { role: "user", content: userBody },
  ];

  const report = toSections(fitted);
  return {
    messages,
    sections: report,
    totalTokens: report.reduce((sum, s) => sum + s.tokens, 0),
    budget,
  };
}

/** 章纲阶段：需要"看得到全局"，所以带全部未回收线索和前文结尾。 */
export function assembleOutlineContext(
  state: StoryState,
  brief: string,
  budget = DEFAULT_TOKEN_BUDGET,
): Assembled {
  const sections: Sec[] = [
    {
      name: "作品设定",
      content: [
        `标题：${state.project.title}`,
        state.project.genre ? `题材：${state.project.genre}` : "",
        state.project.premise ? `核心设定：${state.project.premise}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      name: "风格样本（仅用于判断节奏与语感）",
      content: state.project.style_sample
        ? clip(state.project.style_sample, 1500)
        : "（作者未提供样本，按网文通用节奏处理：短段落、强钩子、多对话。）",
      optional: true,
    },
    { name: "人物档案", content: renderCharacters(state.characters) },
    { name: "未回收线索", content: renderThreads(state.openThreads, state.nextIdx) },
    {
      name: "前文结尾",
      content: state.previousTail
        ? clip(state.previousTail, 1200)
        : "（这是第一章，没有前文。）",
      optional: true,
    },
    {
      name: "本章要求",
      content: [
        `即将撰写：第 ${state.nextIdx} 章`,
        brief.trim() ? `作者要求：${brief.trim()}` : "作者未提出额外要求，按已有线索自然推进。",
      ].join("\n"),
    },
  ];

  return build([loadConstitution(), loadOutlineSkill()], sections, budget);
}

/** 正文阶段：不再需要全部线索（只要本章要用的），但要强化信息边界与字数。 */
export function assembleDraftContext(
  state: StoryState,
  outline: ChapterOutline,
  budget = DEFAULT_TOKEN_BUDGET,
): Assembled {
  const relevantThreads = state.openThreads.filter(
    (t) =>
      outline.threadsToPayoff.includes(t.title) ||
      outline.threadsToPlant.some((p) => p.includes(t.title) || t.title.includes(p)),
  );

  const sections: Sec[] = [
    {
      name: "作品设定",
      content: [
        `标题：${state.project.title}`,
        state.project.genre ? `题材：${state.project.genre}` : "",
        state.project.premise ? `核心设定：${state.project.premise}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      name: "风格样本（模仿其句长与对话密度，不要抄内容）",
      content: state.project.style_sample
        ? clip(state.project.style_sample, 2000)
        : "（作者未提供样本，按网文通用语感：短句为主、对话驱动。）",
      optional: true,
    },
    { name: "人物档案（注意每个人的「不知道」）", content: renderCharacters(state.characters) },
    ...(relevantThreads.length
      ? [
          {
            name: "本章涉及的线索",
            content: renderThreads(relevantThreads, state.nextIdx),
          },
        ]
      : []),
    {
      name: "本章章纲（硬约束，beats 必须全部落地）",
      content: "```json\n" + JSON.stringify(outline, null, 2) + "\n```",
    },
    {
      name: "前文结尾（衔接语气，不要复述）",
      content: state.previousTail
        ? clip(state.previousTail, 1500)
        : "（这是第一章，没有前文。）",
      optional: true,
    },
    {
      name: "硬性要求",
      content: [
        `- 目标字数：约 ${outline.targetWords} 字`,
        `- 章末必须落在：${outline.hook}`,
        "- 直接开始写正文，不要标题、不要说明",
      ].join("\n"),
    },
  ];

  return build([loadConstitution(), loadDraftSkill()], sections, budget);
}
