import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Intersection Map",
  description:
    "A browser-based composition field for arranging photographs into experimental editorial layouts.",
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
