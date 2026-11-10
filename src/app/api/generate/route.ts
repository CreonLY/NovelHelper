import { z } from "zod";
import { generateChapter } from "@/lib/agent/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z
  .object({
    chapterIdx: z.number().int().min(1).max(9999).optional(),
    brief: z.string().max(2000).optional(),
    tokenBudget: z.number().int().min(2000).max(64000).optional(),
  })
  .strict();

/**
 * SSE 生成接口。
 *
 * 为什么用 SSE 而不是 WebSocket：
 *   这里只有"服务端 → 客户端"的单向推送，SSE 基于普通 HTTP，不需要额外握手、
 *   不需要升级连接、可以复用同一套鉴权与代理配置。WebSocket 是给双向实时场景的。
 *
 * 为什么不用"轮询任务状态"：
 *   轮询的延迟感和数据库写放大都不值得。但注意——SSE 只解决"推送"，
 *   真正的可靠性来自 steps 表：连接断了，run 仍然可续。
 */
export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return Response.json(
      {
        error: "参数校验失败",
        issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      },
      { status: 422 },
    );
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        await generateChapter(parsed.data, send);
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // 客户端已断开，忽略
          }
        }
      }
    },
    cancel() {
      // 注意：这里只是停止向前端推送，模型请求本身不会被中断。
      // 生产环境应把 AbortController 传到 workflow 里实现真正取消。
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
