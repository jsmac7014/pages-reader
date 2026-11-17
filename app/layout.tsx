import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pages 읽기",
  description: "브라우저에서 .pages 패키지의 본문과 이미지를 읽습니다.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
