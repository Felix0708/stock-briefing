import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "공시에게 물어봐 | Stock Briefing",
  description: "DART 공시를 근거로 답하는 AI 공시 검색 서비스",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
