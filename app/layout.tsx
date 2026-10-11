import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UX Direct — AI Senior UX Employee",
  description:
    "An AI-native UX partner that reasons, designs, critiques, and improves product experiences.",
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
