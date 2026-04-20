import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "微信风格聊天",
  description: "注册账号、添加好友、与好友私聊",
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
