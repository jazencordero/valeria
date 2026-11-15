import type { Metadata } from "next";
import { Figtree, Fraunces, Geist_Mono } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["SOFT", "opsz"],
  variable: "--font-fraunces",
  display: "swap",
});

const figtree = Figtree({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-figtree",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ready",
  description: "Know if you'll be ready. Start studying in 10 seconds.",
};

// Runs before paint so a saved theme never flashes the wrong colours, and a
// folded sidebar (M4-01, localStorage['ready-side'], same key as SIDE_KEY in
// @/components/shell/use-side) never jumps. It lives here, not in the app
// layout: the root layout renders only on a full page load, so React never
// meets a <script> while rendering on the client.
const themeScript = `try{var t=localStorage.getItem('ready-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);var s=localStorage.getItem('ready-side');if(s==='collapsed'||s==='expanded')document.documentElement.setAttribute('data-side',s)}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${figtree.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
