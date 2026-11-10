import { z } from "zod";

/**
 * 章纲契约。
 *
 * 这一份是"给机器校验的契约"；SKILL.md 里那份 JSON 是"给模型读的契约"。
 * 两者必须同步——真实项目里通常由 zod 反推 JSON Schema 再注入 prompt，
 * 这里保持手写双份，是为了让差异显式可见（也是 Eval 要盯的地方）。
 */

export const ChapterOutlineSchema = z.object({
  title: z.string().min(2).max(30),
  coreEvent: z.string().min(4),
  beats: z.array(z.string().min(4)).min(3).max(10),
  characters: z.array(z.string().min(1)).default([]),
  threadsToPlant: z.array(z.string().min(2)).default([]),
  threadsToPayoff: z.array(z.string().min(2)).default([]),
  emotion: z.string().min(2).default(""),
  hook: z.string().min(2),
  targetWords: z.number().int().min(500).max(6000).default(2600),
  assumptions: z.array(z.string()).default([]),
});

export type ChapterOutline = z.infer<typeof ChapterOutlineSchema>;
