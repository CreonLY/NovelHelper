"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PublicCfg = {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  jsonMode: boolean;
  hasApiKey: boolean;
  apiKeyHint: string;
};

type Preset = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  jsonMode: boolean;
  note: string;
};

type ProjectView = {
  id: string;
  title: string;
  genre: string;
  premise: string;
  styleSample: string;
};

type SectionReport = {
  name: string;
  chars: number;
  tokens: number;
  optional: boolean;
};

type StepView = {
  name: string;
  status: "running" | "done" | "failed";
  error?: string;
};

type LogLine = { t: string; text: string };

const DEFAULT_CFG: PublicCfg = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  temperature: 1,
  maxTokens: 4096,
  jsonMode: true,
  hasApiKey: false,
  apiKeyHint: "",
};

export default function Home() {
  const [cfg, setCfg] = useState<PublicCfg>(DEFAULT_CFG);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [apiKey, setApiKey] = useState("");

  const [project, setProject] = useState<ProjectView>({
    id: "",
    title: "未命名作品",
    genre: "",
    premise: "",
    styleSample: "",
  });

  const [brief, setBrief] = useState("");
  const [chapterIdx, setChapterIdx] = useState(1);

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepView[]>([]);
  const [sections, setSections] = useState<SectionReport[]>([]);
  const [contextInfo, setContextInfo] = useState<{ total: number; budget: number } | null>(null);
  const [outline, setOutline] = useState<unknown>(null);
  const [draft, setDraft] = useState("");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [usage, setUsage] = useState<{ prompt: number; completion: number } | null>(null);
  const [tab, setTab] = useState<"draft" | "outline" | "context" | "log">("draft");
  const [notice, setNotice] = useState("");

  const draftRef = useRef<HTMLDivElement>(null);

  const log = useCallback((text: string) => {
    setLogs((prev) => [
      ...prev.slice(-199),
      { t: new Date().toLocaleTimeString("zh-CN", { hour12: false }), text },
    ]);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [s, p] = await Promise.all([
          fetch("/api/settings").then((r) => r.json()),
          fetch("/api/project").then((r) => r.json()),
        ]);
        setCfg({ ...DEFAULT_CFG, ...s.config });
        setPresets(s.presets ?? []);
        setProject(p.project);
      } catch (e) {
        log(`初始化失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, [log]);

  useEffect(() => {
    const el = draftRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [draft]);

  const saveCfg = async () => {
    setNotice("");
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...cfg, apiKey }),
    });
    const data = await res.json();
    if (!res.ok) {
      setNotice(data.error + "：" + (data.issues ?? []).join("；"));
      return;
    }
    setCfg({ ...DEFAULT_CFG, ...data.config });
    setApiKey("");
    setNotice("模型配置已保存");
  };

  const saveProject = async () => {
    setNotice("");
    const res = await fetch("/api/project", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: project.title,
        genre: project.genre,
        premise: project.premise,
        styleSample: project.styleSample,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setNotice(data.error + "：" + (data.issues ?? []).join("；"));
      return;
    }
    setProject(data.project);
    setNotice("作品设定已保存");
  };

  const applyPreset = (p: Preset) => {
    setCfg((prev) => ({ ...prev, baseUrl: p.baseUrl, model: p.model, jsonMode: p.jsonMode }));
  };

  const run = async () => {
    if (running) return;
    setRunning(true);
    setSteps([]);
    setSections([]);
    setOutline(null);
    setDraft("");
    setUsage(null);
    setLogs([]);
    setTab("draft");
    setNotice("");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chapterIdx, brief }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "{}") continue;

          handleEvent(JSON.parse(payload));
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`失败：${message}`);
      setNotice(`生成失败：${message}`);
    } finally {
      setRunning(false);
    }
  };

  const handleEvent = (ev: Record<string, unknown>) => {
    switch (ev.type) {
      case "run":
        log(`run ${String(ev.runId)} · 第 ${String(ev.chapterIdx)} 章`);
        break;
      case "step":
        setSteps((prev) => {
          const rest = prev.filter((s) => s.name !== String(ev.name));
          return [
            ...rest,
            {
              name: String(ev.name),
              status: ev.status as StepView["status"],
              error: ev.error ? String(ev.error) : undefined,
            },
          ];
        });
        log(`step ${String(ev.name)} → ${String(ev.status)}`);
        break;
      case "context":
        setSections((ev.sections as SectionReport[]) ?? []);
        setContextInfo({
          total: Number(ev.totalTokens ?? 0),
          budget: Number(ev.budget ?? 0),
        });
        log(`上下文装配（${String(ev.step)}）：${String(ev.totalTokens)} tok / 预算 ${String(ev.budget)}`);
        break;
      case "outline":
        setOutline(ev.data);
        log("章纲已通过契约校验");
        break;
      case "delta":
        setDraft((prev) => prev + String(ev.text));
        break;
      case "usage":
        setUsage((prev) => {
          const u = ev.usage as { promptTokens: number; completionTokens: number };
          return {
            prompt: (prev?.prompt ?? 0) + u.promptTokens,
            completion: (prev?.completion ?? 0) + u.completionTokens,
          };
        });
        break;
      case "done":
        log(`完成：${String(ev.words)} 字`);
        setNotice(`第 ${String(ev.chapterIdx)} 章已生成，共 ${String(ev.words)} 字`);
        break;
      case "error":
        log(`错误：${String(ev.message)}`);
        setNotice(`生成失败：${String(ev.message)}`);
        break;
      default:
        log(`未知事件 ${JSON.stringify(ev).slice(0, 120)}`);
    }
  };

  return (
    <main className="app">
      <header className="topbar">
        <h1>NovelHelper</h1>
        <span className="sub">分层上下文 · 故事状态机 · 契约校验</span>
        <span className="spacer" />
        <span className={"badge " + (cfg.hasApiKey ? "ok" : "warn")}>
          {cfg.hasApiKey ? `模型已配置 ${cfg.apiKeyHint}` : "模型未配置"}
        </span>
      </header>

      <div className="grid">
        {/* ── 左列：配置 ─────────────────────────────────────────── */}
        <div className="col">
          <section className="card">
            <h2>
              模型网关
              <span className="badge">{cfg.model}</span>
            </h2>

            {presets.length > 0 && (
              <div className="row" style={{ marginBottom: 12 }}>
                {presets.map((p) => (
                  <button
                    key={p.id}
                    className="btn"
                    title={p.note}
                    onClick={() => applyPreset(p)}
                    type="button"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <div className="field">
              <label>Base URL（OpenAI 兼容端点）</label>
              <input
                className="mono"
                value={cfg.baseUrl}
                onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
              />
            </div>

            <div className="field">
              <label>模型名</label>
              <input
                className="mono"
                value={cfg.model}
                onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              />
            </div>

            <div className="field">
              <label>API Key{cfg.hasApiKey ? "（留空表示不修改）" : ""}</label>
              <input
                className="mono"
                type="password"
                placeholder={cfg.hasApiKey ? "已保存，留空即沿用" : "sk-..."}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>

            <div className="row">
              <div className="field grow">
                <label>温度</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={cfg.temperature}
                  onChange={(e) => setCfg({ ...cfg, temperature: Number(e.target.value) })}
                />
              </div>
              <div className="field grow">
                <label>max_tokens</label>
                <input
                  type="number"
                  min="256"
                  max="65536"
                  value={cfg.maxTokens}
                  onChange={(e) => setCfg({ ...cfg, maxTokens: Number(e.target.value) })}
                />
              </div>
            </div>

            <div className="row" style={{ marginBottom: 12 }}>
              <label className="hint" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={cfg.jsonMode}
                  onChange={(e) => setCfg({ ...cfg, jsonMode: e.target.checked })}
                />
                端点支持 response_format: json_object
              </label>
            </div>

            <button className="btn primary" onClick={() => void saveCfg()} type="button">
              保存模型配置
            </button>
            <p className="hint" style={{ marginTop: 10 }}>
              密钥只存在本地 SQLite（<code>data/novel.db</code>），不会回传到浏览器。
            </p>
          </section>

          <section className="card">
            <h2>作品设定</h2>

            <div className="field">
              <label>标题</label>
              <input
                value={project.title}
                onChange={(e) => setProject({ ...project, title: e.target.value })}
              />
            </div>

            <div className="field">
              <label>题材</label>
              <input
                placeholder="如：东方玄幻 / 都市异能 / 悬疑"
                value={project.genre}
                onChange={(e) => setProject({ ...project, genre: e.target.value })}
              />
            </div>

            <div className="field">
              <label>核心设定（一两段说清世界规则与主线）</label>
              <textarea
                value={project.premise}
                onChange={(e) => setProject({ ...project, premise: e.target.value })}
                placeholder="世界规则、力量体系、主角处境、主线冲突……"
              />
            </div>

            <div className="field">
              <label>风格样本（贴 300~1500 字你自己的旧文或目标文风）</label>
              <textarea
                className="mono"
                value={project.styleSample}
                onChange={(e) => setProject({ ...project, styleSample: e.target.value })}
                placeholder="这段文字会作为 few-shot 影响句长、对话密度与语气，不会抄内容。"
              />
            </div>

            <button className="btn" onClick={() => void saveProject()} type="button">
              保存设定
            </button>
          </section>
        </div>

        {/* ── 右列：运行 ─────────────────────────────────────────── */}
        <div className="col">
          <section className="card">
            <h2>
              生成控制
              {notice && <span className="badge warn">{notice}</span>}
            </h2>

            <div className="row" style={{ marginBottom: 12 }}>
              <div className="field" style={{ width: 100, marginBottom: 0 }}>
                <label>章序</label>
                <input
                  type="number"
                  min="1"
                  value={chapterIdx}
                  onChange={(e) => setChapterIdx(Number(e.target.value))}
                />
              </div>
              <div className="field grow" style={{ marginBottom: 0 }}>
                <label>本章要求（可空）</label>
                <input
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  placeholder="如：让主角第一次动用金手指，但代价要显现"
                />
              </div>
              <button
                className="btn primary"
                style={{ alignSelf: "flex-end" }}
                onClick={() => void run()}
                disabled={running || !cfg.hasApiKey}
                type="button"
              >
                {running ? "生成中…" : "生成本章"}
              </button>
            </div>

            <div className="steps">
              {steps.length === 0 && <span className="muted">尚未运行</span>}
              {steps.map((s) => (
                <div key={s.name} className={`step ${s.status}`}>
                  <span className="dot" />
                  <span>{s.name}</span>
                  <span className="muted">{s.status}</span>
                  {s.error && <span style={{ color: "var(--err)" }}>{s.error}</span>}
                </div>
              ))}
            </div>

            {usage && (
              <p className="hint" style={{ marginTop: 10 }}>
                token：输入 {usage.prompt} / 输出 {usage.completion}
              </p>
            )}
          </section>

          <section className="card">
            <h2>
              输出
              {contextInfo && (
                <span className="badge">
                  {contextInfo.total} / {contextInfo.budget} tok
                </span>
              )}
            </h2>

            <div className="tabs">
              {(
                [
                  ["draft", "正文"],
                  ["outline", "章纲"],
                  ["context", "上下文"],
                  ["log", "日志"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={`tab ${tab === key ? "active" : ""}`}
                  onClick={() => setTab(key)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "draft" && (
              <div className="draft" ref={draftRef}>
                {draft}
              </div>
            )}

            {tab === "outline" && (
              <pre className="pre">{outline ? JSON.stringify(outline, null, 2) : "（待生成）"}</pre>
            )}

            {tab === "context" && (
              <div className="ctx">
                {sections.length === 0 && <span className="muted">（待生成）</span>}
                {sections.map((s) => {
                  const max = Math.max(...sections.map((x) => x.tokens), 1);
                  return (
                    <div key={s.name} className="ctx-row" title={`${s.chars} 字符`}>
                      <span>
                        {s.optional ? "◇ " : "◆ "}
                        {s.name}
                      </span>
                      <span className="muted">{s.tokens} tok</span>
                      <span className="bar">
                        <i
                          className={s.optional ? "opt" : ""}
                          style={{ width: `${Math.round((s.tokens / max) * 100)}%` }}
                        />
                      </span>
                    </div>
                  );
                })}
                <p className="hint" style={{ marginTop: 8 }}>
                  ◆ 必保段（状态事实）　◇ 可裁剪段（预算不足时先砍）
                </p>
              </div>
            )}

            {tab === "log" && (
              <pre className="pre">
                {logs.map((l) => `${l.t}  ${l.text}`).join("\n") || "（暂无）"}
              </pre>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
