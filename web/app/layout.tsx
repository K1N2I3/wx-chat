import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WX 网页聊天",
  description: "跨设备实时聊天",
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
