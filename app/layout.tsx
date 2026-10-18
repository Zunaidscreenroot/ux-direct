import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UX Direct — AI UX Partner",
  description: "A chat-first UX intelligence workspace with free OpenRouter chat, audits, IA discovery, and competitor benchmarking.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
