import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "微聊",
  description: "注册登录、添加好友、私聊，聊天记录持久保存",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
