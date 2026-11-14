import type { Metadata } from "next";
import { Brief } from "@/components/work/brief";
import { cleanBrief } from "@/lib/html/clean";

export const metadata: Metadata = {
  title: "Brief · Ready",
};

// Made-up sample content. The LMS name stands in for the school's `lms`
// value from `src/lib/schools.ts`.
const LMS_NAME = "MyCourses";
const SOURCE_URL = "https://lms.example.edu/mod/assign/view.php?id=1001";

const LONG = `
<h2>Assignment 3: Forecasting demand</h2>
<p>In this assignment you forecast the next <strong>8 weeks</strong> of demand for three products, using two methods, and compare how accurate they are.</p>
<p>The data set is in <a href="https://lms.example.edu/pluginfile.php/4242/mod_assign/introattachment/0/weekly_demand.csv">weekly_demand.csv</a>. Read the <a href="https://example.com/rubric">grading rubric</a> before you start.</p>
<p><img src="https://lms.example.edu/pluginfile.php/4242/mod_assign/intro/chart.png" alt="Demand chart" onerror="alert(1)"></p>
<h3>What to hand in</h3>
<ol>
  <li>A short report (at most <em>four pages</em>) with your method, results and a recommendation.</li>
  <li>Your spreadsheet or notebook, so we can rerun the numbers.</li>
  <li>One chart per product comparing the forecasts with the actual demand.</li>
</ol>
<h3>Methods</h3>
<ul>
  <li>Simple exponential smoothing, with <code>alpha</code> chosen by you.</li>
  <li>Holt's linear trend method.</li>
</ul>
<p>Report the error with this formula:</p>
<pre><code>MAPE = (100 / n) * sum(|actual - forecast| / actual)</code></pre>
<h3>Grading</h3>
<table>
  <thead><tr><th>Part</th><th>Weight</th><th>What we look for</th><th>Common mistakes we saw last year</th></tr></thead>
  <tbody>
    <tr><td>Method</td><td>30%</td><td>Clear choice of parameters, with a reason.</td><td>Picking alpha without saying why.</td></tr>
    <tr><td>Accuracy</td><td>30%</td><td>Errors computed on the hold-out weeks only.</td><td>Testing on the same weeks used to fit.</td></tr>
    <tr><td>Recommendation</td><td>40%</td><td>A method you would use, and when you would switch.</td><td>No recommendation at all.</td></tr>
  </tbody>
</table>
<iframe src="https://video.example/embed/abc">Video walkthrough</iframe>
<p>Questions go to the course forum, or email <a href="mailto:teacher@example.edu">the teacher</a>. <a href="javascript:alert('x')">This link was a trick</a> and is now plain text.</p>
<script>alert("never runs")</script>
`;

const SHORT = `<p>Write <strong>one paragraph</strong> on what surprised you in this week's reading. Hand it in before the seminar.</p>`;

const HOSTILE = `
<p onclick="alert(1)">Every one of these was hostile:</p>
<ul>
  <li><a href="javascript:alert(1)">javascript: link</a></li>
  <li><a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">data: link</a></li>
  <li><img src=x onerror=alert(1)>an image with onerror</li>
  <li><span style="position:fixed;inset:0;background:red">an inline style</span></li>
</ul>
<style>body{display:none}</style>
<script>alert(document.cookie)</script>
`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="mono ink-3 font-medium uppercase tracking-[0.04em]">{title}</h2>
      <div className="rounded-2xl border border-line bg-surface p-5">{children}</div>
    </section>
  );
}

export default function BriefPage() {
  const long = cleanBrief(LONG);
  const short = cleanBrief(SHORT);
  const hostile = cleanBrief(HOSTILE);

  return (
    <main className="mx-auto max-w-2xl space-y-10 px-4 py-10 sm:px-5">
      <header className="space-y-1">
        <h1 className="type-h26">Brief</h1>
        <p className="ink-2">Cleaned assignment brief, collapsed to about eight lines.</p>
      </header>

      <Section title="Long, collapsed">
        <Brief brief={long} lmsName={LMS_NAME} sourceUrl={SOURCE_URL} />
      </Section>

      <Section title="Long, expanded">
        <Brief brief={long} lmsName={LMS_NAME} sourceUrl={SOURCE_URL} defaultExpanded />
      </Section>

      <Section title="Short (no button)">
        <Brief brief={short} lmsName={LMS_NAME} sourceUrl={SOURCE_URL} />
      </Section>

      <Section title="Hostile input, neutralised">
        <Brief brief={hostile} lmsName={LMS_NAME} sourceUrl={SOURCE_URL} />
      </Section>

      <Section title="Pictures dropped, no link to the LMS">
        <Brief brief={cleanBrief('<p>See the diagram below.</p><img src="x.png">')} lmsName={LMS_NAME} />
      </Section>
    </main>
  );
}
