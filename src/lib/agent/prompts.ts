import fs from "node:fs";
import path from "node:path";

/**
 * Prompt 也是代码，必须版本化。
 *
 * 为什么把 SOP 放在 .md 文件而不是字符串常量里：
 *   1. 能用 git diff 看出"这次改了哪句约束"，而不是两个巨型字符串相比；
 *   2. 非工程角色（你自己换个心情时）可以直接改文件；
 *   3. 后续接 Eval 时，样本与本文件是天然的一对。
 *
 * 注意：这里读的是项目目录下的源文件，只适用于本地 `next dev` / `next start`。
 * 若将来部署为 serverless，应改为在构建期把 md 内联进 bundle。
 */

const cache = new Map<string, string>();

function readSkill(relPath: string): string {
  const cached = cache.get(relPath);
  if (cached !== undefined) return cached;

  const full = path.join(process.cwd(), "src", "skills", relPath);
  const raw = fs.readFileSync(full, "utf-8");
  // 去掉可能存在的 front matter
  const text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  cache.set(relPath, text);
  return text;
}

export const loadConstitution = () => readSkill("agent.md");
export const loadOutlineSkill = () => readSkill("outline-chapter/SKILL.md");
export const loadDraftSkill = () => readSkill("draft-chapter/SKILL.md");
