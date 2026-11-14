import { describe, expect, it } from "vitest";
import { cleanBrief, cleanHtml } from "./clean";

/** Parse cleaned output so we test the DOM a browser would build, not the string. */
function dom(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

/** Every attribute name anywhere in the tree. */
function attributeNames(root: HTMLElement): string[] {
  return [...root.querySelectorAll("*")].flatMap((el) => el.getAttributeNames());
}

describe("cleanHtml: hostile input", () => {
  it("removes <img onerror>", () => {
    const out = cleanHtml('<p>Hi<img src="x" onerror="alert(1)"></p>');
    expect(out).toBe("<p>Hi</p>");
    expect(out).not.toMatch(/onerror|alert|<img/i);
  });

  it("removes <script> and its contents", () => {
    const out = cleanHtml("<p>Before</p><script>alert(document.cookie)</script><p>After</p>");
    expect(out).toBe("<p>Before</p><p>After</p>");
  });

  it("removes an unclosed or uppercase <SCRIPT>", () => {
    expect(cleanHtml("<SCRIPT SRC=//evil.example/x.js></SCRIPT>ok")).toBe("ok");
    expect(cleanHtml("ok<script>alert(1)")).toBe("ok");
  });

  it("turns javascript: links into plain text", () => {
    const cases = [
      '<a href="javascript:alert(1)">click</a>',
      '<a href="JaVaScRiPt:alert(1)">click</a>',
      '<a href=" javascript:alert(1)">click</a>',
      '<a href="jav&#x61;script:alert(1)">click</a>',
      '<a href="java\tscript:alert(1)">click</a>',
      '<a href="vbscript:msgbox(1)">click</a>',
    ];
    for (const input of cases) {
      const out = cleanHtml(input);
      expect(out, input).toBe("click");
    }
  });

  it("turns data: links into plain text", () => {
    expect(cleanHtml('<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>')).toBe("x");
  });

  it("drops data: images", () => {
    const res = cleanBrief('<p>Look<img src="data:image/png;base64,iVBORw0KGgo="></p>');
    expect(res.html).toBe("<p>Look</p>");
    expect(res.droppedMedia).toBe(true);
  });

  it("strips every on* event attribute", () => {
    const out = cleanHtml(
      '<p onclick="a()" onmouseover="b()">One</p>' +
        '<a href="https://example.com" onfocus="c()" onclick="d()">Two</a>' +
        '<table onload="e()"><tr><td onmouseenter="f()">Three</td></tr></table>' +
        '<h2 ONCLICK="g()">Four</h2>',
    );
    expect(attributeNames(dom(out)).filter((n) => n.startsWith("on"))).toEqual([]);
    expect(out).not.toMatch(/\bon[a-z]+=/i);
    expect(out).toContain("One");
    expect(out).toContain("Three");
  });

  it("removes <style> tags and style attributes", () => {
    const out = cleanHtml(
      '<style>body{display:none}</style><p style="position:fixed;inset:0">Text</p>',
    );
    expect(out).toBe("<p>Text</p>");
  });

  it("removes iframes, with any fallback text inside", () => {
    const res = cleanBrief(
      '<p>Watch:</p><iframe src="https://video.example/embed/1" srcdoc="<script>alert(1)</script>">Your browser</iframe>',
    );
    expect(res.html).toBe("<p>Watch:</p>");
    expect(res.droppedMedia).toBe(true);
  });

  it("removes video, audio, object, embed and svg", () => {
    const res = cleanBrief(
      '<video src="a.mp4">fallback</video><audio src="a.mp3"></audio>' +
        '<object data="x.swf"></object><embed src="x.swf">' +
        '<svg onload="alert(1)"><script>alert(2)</script></svg><p>ok</p>',
    );
    expect(res.html).toBe("<p>ok</p>");
    expect(res.droppedMedia).toBe(true);
  });

  it("removes forms, inputs and buttons", () => {
    const out = cleanHtml(
      '<form action="https://evil.example"><input name="pw"><button>Send</button></form><p>ok</p>',
    );
    expect(out).toBe("<p>ok</p>");
  });

  it("removes class, id and data attributes", () => {
    const out = cleanHtml('<p class="x" id="main" data-x="1" aria-hidden="true">Hi</p>');
    expect(out).toBe("<p>Hi</p>");
  });

  it("does not let a <meta> or <base> through", () => {
    const out = cleanHtml(
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><p>ok</p>',
    );
    expect(out).toBe("<p>ok</p>");
  });

  it("escapes text that looks like markup", () => {
    const out = cleanHtml("<p>a &lt;script&gt;alert(1)&lt;/script&gt; b</p>");
    expect(dom(out).querySelector("script")).toBeNull();
    expect(dom(out).textContent).toBe("a <script>alert(1)</script> b");
  });
});

describe("cleanHtml: Moodle file links", () => {
  it("rewrites pluginfile.php links to their text", () => {
    const out = cleanHtml(
      '<p>See <a href="https://moodle.example.edu/pluginfile.php/123/mod_assign/intro/A3_brief.pdf">A3_brief.pdf</a>.</p>',
    );
    expect(out).toBe("<p>See A3_brief.pdf.</p>");
  });

  it("keeps the next link intact after a rewritten one", () => {
    const out = cleanHtml(
      '<p><a href="https://moodle.example.edu/pluginfile.php/1/a.csv">a.csv</a> and ' +
        '<a href="https://example.com/rubric">rubric</a> then text.</p>' +
        '<p><a href="javascript:x()">bad</a> <a href="https://example.com/b">b</a> after</p>',
    );
    expect(out).toBe(
      '<p>a.csv and <a href="https://example.com/rubric" target="_blank" rel="noopener noreferrer">rubric</a> then text.</p>' +
        '<p>bad <a href="https://example.com/b" target="_blank" rel="noopener noreferrer">b</a> after</p>',
    );
  });

  it("rewrites the webservice variant too", () => {
    const out = cleanHtml(
      '<a href="https://moodle.example.edu/webservice/pluginfile.php/9/x.csv?token=abc">x.csv</a>',
    );
    expect(out).toBe("x.csv");
    expect(out).not.toContain("token");
  });

  it("drops a pluginfile image and flags it", () => {
    const res = cleanBrief(
      '<p>Chart:</p><p><img src="https://moodle.example.edu/pluginfile.php/1/chart.png" alt="Chart"></p>',
    );
    expect(res.html).toBe("<p>Chart:</p><p></p>");
    expect(res.droppedMedia).toBe(true);
  });
});

describe("cleanHtml: what stays", () => {
  it("keeps paragraphs, bold and italics", () => {
    const input = "<p>Use <strong>two</strong> <em>methods</em>, <b>bold</b> and <i>italic</i>.</p>";
    expect(cleanHtml(input)).toBe(input);
  });

  it("keeps lists", () => {
    const input = '<ol start="2"><li>One</li><li>Two</li></ol><ul><li>A</li></ul>';
    expect(cleanHtml(input)).toBe(input);
  });

  it("moves headings down so a brief never outranks the page", () => {
    expect(cleanHtml("<h1>A</h1><h2>B</h2><h3>C</h3><h5>D</h5>")).toBe(
      "<h3>A</h3><h3>B</h3><h4>C</h4><h4>D</h4>",
    );
  });

  it("keeps tables with spans", () => {
    const input =
      '<table><thead><tr><th scope="col">Part</th><th>Weight</th></tr></thead>' +
      '<tbody><tr><td colspan="2">Report</td></tr></tbody></table>';
    expect(cleanHtml(input)).toBe(input);
  });

  it("keeps inline code and code blocks", () => {
    const input = "<p>Run <code>forecast()</code></p><pre><code>x = 1\ny = 2</code></pre>";
    expect(cleanHtml(input)).toBe(input);
  });

  it("forces target and rel on http and https links", () => {
    const out = cleanHtml(
      '<a href="https://example.com/rubric" target="_self" rel="opener" title="t">Rubric</a>' +
        '<a href="http://example.org">Old</a>',
    );
    const links = [...dom(out).querySelectorAll("a")];
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttributeNames().sort()).toEqual(["href", "rel", "target"]);
    }
    expect(links[0].getAttribute("href")).toBe("https://example.com/rubric");
  });

  it("keeps mailto links", () => {
    const a = dom(cleanHtml('<a href="mailto:teacher@example.edu">Email</a>')).querySelector("a");
    expect(a?.getAttribute("href")).toBe("mailto:teacher@example.edu");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("turns relative and protocol-relative links into text", () => {
    expect(cleanHtml('<a href="/mod/assign/view.php">here</a>')).toBe("here");
    expect(cleanHtml('<a href="//evil.example">here</a>')).toBe("here");
    expect(cleanHtml('<a href="#top">here</a>')).toBe("here");
    expect(cleanHtml("<a>here</a>")).toBe("here");
  });

  it("keeps the text of unknown wrappers", () => {
    expect(cleanHtml('<section><article><font color="red">Due Friday</font></article></section>')).toBe(
      "Due Friday",
    );
  });

  it("reports no dropped media for a text-only brief", () => {
    expect(cleanBrief("<p>Just text.</p>").droppedMedia).toBe(false);
  });

  it("handles empty input", () => {
    expect(cleanHtml("")).toBe("");
    expect(cleanBrief("   ").html).toBe("");
  });
});
