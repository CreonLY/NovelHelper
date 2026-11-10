import { getDb, newId, nowIso } from "../db";

/**
 * Agent Loop 的最小骨架。
 *
 * 把"Agent"拆开看，它就是一个 while 循环 + 四段确定性代码：
 *
 *   while (!done) {
 *     ctx    = assemble(state)   ← 确定性
 *     msg    = await llm(ctx)    ← 概率性（唯一一段例外）
 *     action = validate(msg)    ← 确定性
 *     state  = apply(state, action) ← 确定性
 *     persist(state)            ← 确定性
 *   }
 *
 * 本文件的 runStep 负责 persist + 事件上报；assemble / validate 分别在
 * assembler.ts 与 gateway.callStructured 里。三者合起来才是完整的 Harness。
 */

export type Emit = (event: Record<string, unknown>) => void;

export type RunStatus = "running" | "done" | "failed" | "paused";

export function startRun(projectId: string, kind: string, input: unknown): string {
  const id = newId("run");
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO runs (id, project_id, kind, status, input, output, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, '{}', ?, ?)`,
    )
    .run(id, projectId, kind, JSON.stringify(input ?? {}), ts, ts);
  return id;
}

export function finishRun(
  runId: string,
  status: RunStatus,
  output: unknown = {},
  error?: string,
): void {
  getDb()
    .prepare(
      `UPDATE runs SET status = ?, output = ?, error = ?, updated_at = ? WHERE id = ?`,
    )
    .run(status, JSON.stringify(output ?? {}), error ?? null, nowIso(), runId);
}

/**
 * 执行一个 step 并落盘。
 *
 * 为什么每一步都要落盘而不是等整个 run 结束再写：
 *   长文本生成动辄几分钟。中途断网、刷新页面、进程被杀，都会丢结果。
 *   落盘后可以"断点续跑"，这是 Harness 相对裸调 API 最实际的工程价值。
 */
export async function runStep<T>(args: {
  runId: string;
  seq: number;
  name: string;
  input?: unknown;
  emit: Emit;
  fn: (stepId: string) => Promise<T>;
}): Promise<T> {
  const db = getDb();
  const id = newId("step");
  const started = nowIso();

  db.prepare(
    `INSERT INTO steps (id, run_id, seq, name, status, input, output, started_at)
     VALUES (?, ?, ?, ?, 'running', ?, '{}', ?)`,
  ).run(id, args.runId, args.seq, args.name, JSON.stringify(args.input ?? {}), started);

  args.emit({ type: "step", name: args.name, seq: args.seq, status: "running", stepId: id });

  try {
    const output = await args.fn(id);
    db.prepare(
      `UPDATE steps SET status = 'done', output = ?, finished_at = ? WHERE id = ?`,
    ).run(JSON.stringify(output ?? {}), nowIso(), id);
    args.emit({ type: "step", name: args.name, seq: args.seq, status: "done", stepId: id });
    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE steps SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
    ).run(message, nowIso(), id);
    args.emit({
      type: "step",
      name: args.name,
      seq: args.seq,
      status: "failed",
      stepId: id,
      error: message,
    });
    throw err;
  }
}
