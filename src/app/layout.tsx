import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ready",
  description: "Know if you'll be ready. Start studying in 10 seconds.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-stone-50">{children}</body>
    </html>
  );
}
