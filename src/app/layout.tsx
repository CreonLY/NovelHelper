import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NovelHelper · 网文写作工作台",
  description: "分层上下文 + 故事状态机 + 契约校验的长篇小说 Agent",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
