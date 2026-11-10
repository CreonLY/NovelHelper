import { z } from "zod";
import { getSetting, setSetting } from "./db";

/**
 * 模型配置 = 一个“OpenAI 兼容端点”的 5 个字段。
 *
 * 为什么只有 5 个字段就能覆盖 DeepSeek / 通义 / 豆包 / 中转站：
 *   因为它们绝大多数都把接口对齐成了 /v1/chat/completions。
 *   真正需要适配的差异只有两处：是否支持 response_format、是否支持 stream_options，
 *   这两点在下面 jsonMode / 网关降级逻辑里处理。
 */

const httpUrl = z
  .string()
  .min(1, "必填")
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "必须是 http(s) 开头的合法地址");

export const ModelConfigSchema = z.object({
  baseUrl: httpUrl.default("https://api.deepseek.com/v1"),
  model: z.string().min(1).default("deepseek-chat"),
  apiKey: z.string().default(""),
  temperature: z.number().min(0).max(2).default(1),
  maxTokens: z.number().int().min(256).max(65536).default(4096),
  /** 端点是否支持 response_format: json_object。中转站偶尔不支持，关掉后走“提示词 + 代码校验”。 */
  jsonMode: z.boolean().default(true),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * 局部更新用的契约。
 * 故意不用 ModelConfigSchema.partial()：那样字段上的 .default() 会把"没传"当成"传了默认值"，
 * 一次只改温度的请求会把用户填好的 baseUrl 重置掉。这类"默认值偷偷覆盖"是配置系统最常见的坑。
 */
export const ModelConfigPatchSchema = z
  .object({
    baseUrl: httpUrl.optional(),
    model: z.string().min(1).optional(),
    apiKey: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(256).max(65536).optional(),
    jsonMode: z.boolean().optional(),
  })
  .strict();

export type ModelConfigPatch = z.infer<typeof ModelConfigPatchSchema>;

const SETTING_KEY = "llm.config";

export function loadModelConfig(): ModelConfig {
  const raw = getSetting(SETTING_KEY);
  if (!raw) return ModelConfigSchema.parse({});
  try {
    return ModelConfigSchema.parse(JSON.parse(raw));
  } catch {
    // 配置脏了就回落到默认值，不让一条坏配置把整个应用卡死
    return ModelConfigSchema.parse({});
  }
}

export function saveModelConfig(patch: Partial<ModelConfig>): ModelConfig {
  const current = loadModelConfig();
  // 前端回传空字符串表示“不改密钥”（避免把掩码写回数据库）
  const merged: ModelConfig = {
    ...current,
    ...patch,
    apiKey: patch.apiKey && patch.apiKey.trim().length > 0 ? patch.apiKey.trim() : current.apiKey,
  };
  const validated = ModelConfigSchema.parse(merged);
  setSetting(SETTING_KEY, JSON.stringify(validated));
  return validated;
}

/** 给前端看的视图：绝不回传明文密钥。 */
export function publicModelConfig(cfg: ModelConfig) {
  const key = cfg.apiKey;
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    jsonMode: cfg.jsonMode,
    hasApiKey: key.length > 0,
    apiKeyHint: key.length > 0 ? `${key.slice(0, 3)}…${key.slice(-4)}` : "",
  };
}

export type PublicModelConfig = ReturnType<typeof publicModelConfig>;

export const MODEL_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    jsonMode: true,
    note: "直连 api.deepseek.com，按量计费，无需中转",
  },
  {
    id: "relay",
    label: "中转站 / 自建网关",
    baseUrl: "https://your-relay.example.com/v1",
    model: "deepseek-chat",
    jsonMode: true,
    note: "one-api / new-api 这类中转，协议与 OpenAI 一致",
  },
] as const;
