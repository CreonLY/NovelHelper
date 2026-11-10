import { z } from "zod";
import { getOrCreateDefaultProject, getDb, updateProject } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ProjectPatchSchema = z
  .object({
    title: z.string().min(1).max(80).optional(),
    genre: z.string().max(40).optional(),
    premise: z.string().max(4000).optional(),
    styleSample: z.string().max(12000).optional(),
  })
  .strict();

export async function GET() {
  const project = getOrCreateDefaultProject();
  const chapters = getDb()
    .prepare(
      "SELECT id, idx, title, word_count, status FROM chapters WHERE project_id = ? ORDER BY idx DESC LIMIT 20",
    )
    .all(project.id);

  return Response.json({
    project: {
      id: project.id,
      title: project.title,
      genre: project.genre,
      premise: project.premise,
      styleSample: project.style_sample,
    },
    chapters,
  });
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = ProjectPatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: "设定校验失败",
        issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      },
      { status: 422 },
    );
  }

  const project = getOrCreateDefaultProject();
  updateProject(project.id, {
    title: parsed.data.title,
    genre: parsed.data.genre,
    premise: parsed.data.premise,
    style_sample: parsed.data.styleSample,
  });

  const updated = getOrCreateDefaultProject();
  return Response.json({
    project: {
      id: updated.id,
      title: updated.title,
      genre: updated.genre,
      premise: updated.premise,
      styleSample: updated.style_sample,
    },
  });
}
