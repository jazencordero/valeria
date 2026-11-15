import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SignInTests } from "./tests";
import { SCHOOLS } from "@/lib/schools";

const LMS = SCHOOLS.aalto.lms;

export const metadata: Metadata = {
  title: "Sign-in test · Ready",
  robots: { index: false, follow: false },
};

// Dev-only: two checks with a real Moodle account on a preview link.
// Never on the live site.
export default function Page() {
  if (process.env.VERCEL_ENV === "production") notFound();

  return (
    <main className="mx-auto max-w-xl px-4 py-8 text-ink">
      <h1 className="text-xl font-semibold">Sign-in test</h1>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-2">
        <li>In {LMS} on her phone or laptop, open Profile and show the QR code.</li>
        <li>Test A: copy the QR&apos;s text (any QR reader app) into the box and press Try within a minute.</li>
        <li>Test B: on this laptop, signed in to {LMS} in this browser, press the button and allow the link type if asked.</li>
      </ol>
      <SignInTests />
    </main>
  );
}
