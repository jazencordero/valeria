/**
 * Privacy, in plain words (M8-33). One static page, outside the signed-in
 * frame ((app)/layout.tsx), so it renders for anyone: it reads no cookie, no
 * user and no database. The connect screen links here next to its checkbox.
 *
 * Every sentence states something the code or context/ai/providers.md
 * (checked 2026-11-14) backs. When a provider, a retention rule or the list of
 * tables changes, change the sentence here too:
 * - what is kept: src/server/db/schema, src/server/files/extract.ts (file
 *   bytes are never stored), src/server/handin/prepare.ts (nor hand-in bytes);
 * - the sealed key: src/server/crypto/seal.ts (AES-256-GCM);
 * - AI: src/server/ai/providers.config.ts, src/server/ai/consent.ts (her
 *   switch and the two course rules), src/server/chat/context.ts;
 * - how long: src/server/users/cleanup.ts (30 and 7 days),
 *   src/server/auth/session.ts (cookie, one year);
 * - download: src/app/api/export/route.ts; delete: (app)/settings/actions.ts.
 *
 * The school and its LMS name come from src/lib/schools.ts (no screen names an
 * LMS itself). With no user to ask, this page speaks about the default school.
 *
 * Not a lawyer's policy (the ticket's cut). The wording is Jazen's to approve.
 */
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { DEFAULT_SCHOOL, SCHOOLS } from "@/lib/schools";

export const metadata: Metadata = { title: "Privacy · Ready" };

/** Blank on purpose: the repository is public, so Jazen adds the address himself. */
const CONTACT = "[contact address: Jazen to fill in]";
/** Blank on purpose: how long the database host keeps deleted rows in its backups is not in the repo. */
const BACKUPS = "[how long backups are kept: Jazen to fill in]";

const LINK =
  "font-medium text-ink underline decoration-line decoration-2 underline-offset-4 hover:decoration-accent";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="space-y-3">
      <h2 id={`${id}-title`} className="type-h22">
        {title}
      </h2>
      {children}
    </section>
  );
}

function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
}

export default function PrivacyPage() {
  const school = SCHOOLS[DEFAULT_SCHOOL];
  const lms = school.lms;

  return (
    <main className="mx-auto max-w-xl space-y-10 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">What Ready keeps, in plain words</h1>
        <p>
          Ready is a small study app. It reads your courses from {lms} so you can see what is due and start studying.
          This page says what it keeps, where, and how to get it out or delete it.
        </p>
        <p className="fine">Last changed 15 November 2026. This is a plain description, not a legal document.</p>
      </header>

      <Section id="who" title="Who runs Ready">
        <p>
          Ready is made and run by Jazen, one person, not a company. Questions, or anything you want removed: {CONTACT}.
        </p>
        <p>
          Ready is not run, checked or endorsed by {school.full}. {lms} belongs to {school.name}. Ready only connects to
          it with your key.
        </p>
      </Section>

      <Section id="kept" title="What Ready keeps">
        <List>
          <li>
            <strong>Your account.</strong> An id, your name as {lms} gives it, your school, your settings, and the time
            you ticked the box on the connect screen.
          </li>
          <li>
            <strong>Your {lms} key.</strong> Stored encrypted. Ready uses it for two things only: to read your courses,
            and to hand in a file when you tap. Ready never asks for your {school.name} password and never sees it.
          </li>
          <li>
            <strong>What it reads from {lms}.</strong> Your courses, assignments, deadlines and grades, and the list of
            course files (names and sizes).
          </li>
          <li>
            <strong>The text of course files.</strong> Ready pulls the text out of PDFs and text files and keeps that
            text. It does not keep the files themselves.
          </li>
          <li>
            <strong>What you make in Ready.</strong> Chats, drafts, notes, highlights, exams, cards, your answers and
            your study sessions.
          </li>
          <li>
            <strong>A cookie in this browser.</strong> It keeps you signed in for up to a year. Ready stores which kind
            of browser it is. There are no ad or tracking cookies.
          </li>
        </List>
        <p>
          A file you hand in passes through Ready on its way to {lms}. Ready does not keep it.
        </p>
      </Section>

      <Section id="where" title="Where it is kept">
        <p>
          In one database in the EU (Frankfurt), hosted by Neon. The app itself runs on Vercel, also in Frankfurt. Your
          key is encrypted before it is saved, with a secret that is not in the database.
        </p>
      </Section>

      <Section id="ai" title="What goes to AI services">
        <p>
          Ready uses free AI models from three outside services: Groq, OpenRouter (its free models, which are served by
          Ant Digital and Google AI Studio) and Cloudflare Workers AI. Most of this processing happens outside the EU,
          mainly in the United States.
        </p>
        <p>Course material goes to them only when both of these are true:</p>
        <List>
          <li>you marked the course as allowing AI, and</li>
          <li>
            your switch &ldquo;Use my course files with AI&rdquo; is on (
            <Link href="/settings#privacy" className={LINK}>
              Settings
            </Link>
            ).
          </li>
        </List>
        <p>
          A new course starts as &ldquo;not allowed&rdquo; until you say otherwise. Assignment help and studying from
          slides are two separate choices for each course.
        </p>
        <p>What is sent then:</p>
        <List>
          <li>what you type in a chat, and the chat so far;</li>
          <li>the assignment text, your draft, and the parts of course files the chat looks up;</li>
          <li>the text of slides, to make cards, concepts and lecture pages.</li>
        </List>
        <p>
          If you set a course to &ldquo;explain only&rdquo;, the chat gets the name of the assignment, the name of the
          course, the due time and the file names. It does not get the text.
        </p>
        <p>
          <strong>Free services may log what is sent.</strong> When we checked their own pages on 14 November 2026, none
          of the three used prompts to train models. Groq keeps logs for up to 30 days. Google AI Studio keeps what it
          receives for 55 days. Free terms can change without notice, so do not type anything into a chat that you would
          not want an outside service to see.
        </p>
        <p>
          <strong>The tutor.</strong> Only if the tutor is switched on for your account: what you type to it, the chat
          so far, and where you are in Ready (which lecture, exam, card or assignment page) go to the same free services
          as above. The part of a lecture you are on, or a card you have already answered, goes with it only for a course
          you marked as allowing AI for studying. Only if whoever runs Ready has set an Anthropic key, the tutor asks
          Anthropic&rsquo;s Claude first and uses the free services when Claude does not answer or this
          month&rsquo;s tutor budget is used up. A passage you highlight goes with your question only for a course
          you marked as allowing AI for studying. &ldquo;Copy for Claude&rdquo; sends nothing: it only puts text on
          your clipboard. Ready keeps your tutor chats on its server, each with the note or the page it belongs
          to, which model answered and how many tokens it used, so a chat is there when you open it again. They
          stay until you delete them: a note&rsquo;s chat goes with the note, and all of them go when you delete
          your account. They are in your data download.
        </p>
        <p>
          Ready itself keeps your chats. For each AI call it also notes which service answered and how long it took,
          not the text. Answers made from course material (cards, explanations, time estimates) are saved so the same
          question is not asked twice. That store holds no names.
        </p>
      </Section>

      <Section id="how-long" title="How long things are kept">
        <List>
          <li>While you are connected: until you delete them. Nothing is removed on a timer.</li>
          <li>
            If you disconnect {lms}: your key is deleted right away. Your courses, deadlines and progress stay until
            you delete your account.
          </li>
          <li>If you open Ready and never connect: after 30 days without a visit, what was stored is deleted.</li>
          <li>The demo: deleted after 7 days without a visit.</li>
        </List>
      </Section>

      <Section id="download" title="Download everything">
        <p>
          <a href="/api/export" className={LINK}>
            Download my data
          </a>{" "}
          gives you one file with everything Ready holds for you. It works in a browser where you are signed in to
          Ready. Your key and a few technical secrets are left out of the file.
        </p>
      </Section>

      <Section id="delete" title="Delete everything">
        <p>
          Go to{" "}
          <Link href="/settings#your-data" className={LINK}>
            Settings, Your data
          </Link>
          , type the word it asks for and confirm. Your account, your key and everything listed above are deleted at
          once.
        </p>
        <p>What can remain after that:</p>
        <List>
          <li>counts of AI calls, with no link to you;</li>
          <li>saved AI answers made from course material, with no name on them;</li>
          <li>whatever the AI services logged on their side, for as long as they keep it;</li>
          <li>copies in the database host&rsquo;s backups: {BACKUPS}.</li>
        </List>
        <p>
          Deleting your account removes Ready&rsquo;s copy of your key. To make the key itself stop working, reset it in{" "}
          {lms}.
        </p>
      </Section>

      <Section id="never" title="What Ready never does">
        <List>
          <li>Hand in without your tap.</li>
          <li>Sell your data, or share it with anyone other than the services named on this page.</li>
          <li>Ask for your {school.name} password.</li>
        </List>
      </Section>
    </main>
  );
}
