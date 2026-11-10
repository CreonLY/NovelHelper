import {
  MODEL_PRESETS,
  ModelConfigPatchSchema,
  loadModelConfig,
  publicModelConfig,
  saveModelConfig,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = loadModelConfig();
  return Response.json({
    config: publicModelConfig(cfg),
    presets: MODEL_PRESETS,
    env: {
      node: process.version,
      // 排查"为什么连不上"时，这三个值比任何日志都直观
      hasKey: cfg.apiKey.length > 0,
      endpoint: `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    },
  });
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = ModelConfigPatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: "配置校验失败",
        issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      },
      { status: 422 },
    );
  }

  const saved = saveModelConfig(parsed.data);
  return Response.json({ config: publicModelConfig(saved) });
}
