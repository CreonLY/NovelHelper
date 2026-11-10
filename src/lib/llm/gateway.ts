import { z } from "zod";
import { getDb, newId, nowIso } from "../db";
import type { ModelConfig } from "../config";

/**
 * Model Gateway —— 模型调用的唯一出口。
 *
 * 铁律：业务代码不允许出现第二处 fetch(".../chat/completions")。
 * 类比：业务层不允许直连数据库，必须走 DAO。否则后面换模型、加计费、加 Trace
 * 要改十几个地方，而且必然改漏。
 */

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type Usage = { promptTokens: number; completionTokens: number };

export class LLMHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`模型接口返回 HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "LLMHttpError";
    this.status = status;
    this.body = body;
  }
}

export class SchemaValidationError extends Error {
  issues: string;
  raw: string;
  constructor(issues: string, raw: string) {
    super(`结构化输出未通过契约校验: ${issues}`);
    this.name = "SchemaValidationError";
    this.issues = issues;
    this.raw = raw;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function isRetryable(err: unknown): boolean {
  if (err instanceof LLMHttpError) return RETRYABLE_STATUS.has(err.status);
  if (err instanceof Error) {
    // AbortError / TimeoutError / 网络层 ENOTFOUND、ECONNRESET 等
    return true;
  }
  return true;
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 粗略 token 估算：中文约 1.6~1.8 字符/token，英文约 4 字符/token。仅用于预算控制。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.7);
}

export function countMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

type CallRecordInput = {
  runId?: string | null;
  stepId?: string | null;
  cfg: ModelConfig;
  usage: Usage;
  latencyMs: number;
  attempts: number;
  status: "ok" | "error";
  error?: string | null;
};

/** 调用账本：每次调用都落库。没有这层，成本和故障都无从复盘。 */
export function recordCall(input: CallRecordInput): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO llm_calls
          (id, run_id, step_id, base_url, model, prompt_tokens, completion_tokens,
           latency_ms, attempts, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("call"),
        input.runId ?? null,
        input.stepId ?? null,
        input.cfg.baseUrl,
        input.cfg.model,
        input.usage.promptTokens,
        input.usage.completionTokens,
        input.latencyMs,
        input.attempts,
        input.status,
        input.error ?? null,
        nowIso(),
      );
  } catch (e) {
    // 记账失败不能影响主流程
    console.error("[gateway] recordCall failed", e);
  }
}

export type CallOptions = {
  runId?: string | null;
  stepId?: string | null;
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

async function postWithRetry(
  cfg: ModelConfig,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const maxAttempts = 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new LLMHttpError(res.status, text);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryable(err)) break;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastErr;
}

function latencySince(start: number): number {
  return Math.round(performance.now() - start);
}

/** 一次性调用（非流式）。 */
export async function callChat(
  cfg: ModelConfig,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<{ text: string; usage: Usage; attempts: number }> {
  if (!cfg.apiKey) {
    throw new Error("尚未配置模型 API Key，请先在工作台顶部完成模型设置");
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    stream: false,
  };
  if (opts.jsonMode ?? cfg.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const started = performance.now();
  let res: Response;
  try {
    res = await postWithRetry(cfg, body, opts.timeoutMs ?? 120_000);
  } catch (err) {
    // 端点不支持 response_format 时自动降级（中转站常见）
    const notSupported =
      err instanceof LLMHttpError &&
      err.status === 400 &&
      /response_format|json_object/i.test(err.body);
    if (notSupported && body.response_format) {
      delete body.response_format;
      res = await postWithRetry(cfg, body, opts.timeoutMs ?? 120_000);
    } else {
      recordCall({
        runId: opts.runId,
        stepId: opts.stepId,
        cfg,
        usage: { promptTokens: countMessagesTokens(messages), completionTokens: 0 },
        latencyMs: latencySince(started),
        attempts: 3,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = json.choices?.[0]?.message?.content ?? "";
  const usage: Usage = {
    promptTokens: json.usage?.prompt_tokens ?? countMessagesTokens(messages),
    completionTokens: json.usage?.completion_tokens ?? estimateTokens(text),
  };

  recordCall({
    runId: opts.runId,
    stepId: opts.stepId,
    cfg,
    usage,
    latencyMs: latencySince(started),
    attempts: 1,
    status: "ok",
  });

  return { text, usage, attempts: 1 };
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: Usage };

/**
 * 流式调用。返回异步生成器：调用方边收边推给前端（SSE），
 * 同时 Harness 可以在流结束后做校验、落库、记账。
 */
export async function* streamChat(
  cfg: ModelConfig,
  messages: ChatMessage[],
  opts: CallOptions = {},
): AsyncGenerator<StreamEvent> {
  if (!cfg.apiKey) {
    throw new Error("尚未配置模型 API Key，请先在工作台顶部完成模型设置");
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  const started = performance.now();
  let res: Response;
  try {
    res = await postWithRetry(cfg, body, opts.timeoutMs ?? 300_000);
  } catch (err) {
    const notSupported =
      err instanceof LLMHttpError && err.status === 400 && /stream_options/i.test(err.body);
    if (notSupported) {
      delete body.stream_options;
      res = await postWithRetry(cfg, body, opts.timeoutMs ?? 300_000);
    } else {
      recordCall({
        runId: opts.runId,
        stepId: opts.stepId,
        cfg,
        usage: { promptTokens: countMessagesTokens(messages), completionTokens: 0 },
        latencyMs: latencySince(started),
        attempts: 3,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  if (!res.body) throw new Error("模型接口没有返回流式 body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let emitted = "";
  let usage: Usage | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");

      const line = rawLine.replace(/\r$/, "").trim();
      if (!line || !line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        nl = -1;
        break;
      }
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          emitted += delta;
          yield { type: "delta", text: delta };
        }
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      } catch {
        // 单个坏 chunk 不该中断整条流
      }
    }
  }

  const finalUsage: Usage = usage ?? {
    promptTokens: countMessagesTokens(messages),
    completionTokens: estimateTokens(emitted),
  };

  recordCall({
    runId: opts.runId,
    stepId: opts.stepId,
    cfg,
    usage: finalUsage,
    latencyMs: latencySince(started),
    attempts: 1,
    status: "ok",
  });

  yield { type: "usage", usage: finalUsage };
}

/** 从模型输出里抠 JSON：兼容 ```json 代码块、前后夹带解释。 */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) return candidate;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(close);
  return end > start ? candidate.slice(start, end + 1) : candidate;
}

/**
 * 结构化输出：契约校验 + 失败自修复。
 *
 * 这是“用确定性代码兜底模型不确定性”的最具体形状：
 *   模型给出 JSON → zod 校验（确定性）→ 不通过就把错误回灌给它再修一次（有次数上限）
 *   → 仍然不通过就抛错，交给上层决定是降级、跳过还是中断。
 * 绝不接受“看起来差不多”的输出直接入库。
 */
export async function callStructured<T>(args: {
  cfg: ModelConfig;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  runId?: string | null;
  stepId?: string | null;
  jsonMode?: boolean;
  maxRepair?: number;
  temperature?: number;
  maxTokens?: number;
}): Promise<{ data: T; usage: Usage; attempts: number }> {
  const { cfg, schema } = args;
  const maxRepair = args.maxRepair ?? 2;
  const messages: ChatMessage[] = [...args.messages];

  let usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let lastRaw = "";
  let lastIssues = "";

  for (let attempt = 1; attempt <= maxRepair; attempt++) {
    const res = await callChat(cfg, messages, {
      runId: args.runId,
      stepId: args.stepId,
      jsonMode: args.jsonMode ?? cfg.jsonMode,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
    });
    usage = {
      promptTokens: usage.promptTokens + res.usage.promptTokens,
      completionTokens: usage.completionTokens + res.usage.completionTokens,
    };
    lastRaw = res.text;

    const parsed = schema.safeParse(safeJsonParse(extractJson(res.text)));
    if (parsed.success) {
      return { data: parsed.data, usage, attempts: attempt };
    }

    lastIssues = parsed.error.issues
      .map((i: { path: PropertyKey[]; message: string }) =>
        `${i.path.join(".") || "(root)"}: ${i.message}`,
      )
      .join("; ");

    // 把校验错误作为“可修正的反馈”回灌，而不是直接重发同一个问题
    messages.push({ role: "assistant", content: res.text });
    messages.push({
      role: "user",
      content: `上一次输出未通过契约校验，问题如下：\n${lastIssues}\n\n请仅输出修正后的 JSON 对象，不要解释，不要 markdown 代码块。`,
    });
  }

  throw new SchemaValidationError(lastIssues, lastRaw);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
