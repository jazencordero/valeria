/**
 * Clean an assignment brief from Moodle before it reaches the screen.
 *
 * Moodle stores briefs as teacher-written HTML. We show it with
 * `dangerouslySetInnerHTML`, so everything goes through an allow-list first:
 * text structure stays (headings, paragraphs, lists, links, bold, italics,
 * tables, code); scripts, styles, iframes, images, video, forms, inline
 * styles, classes and every event attribute go.
 *
 * Links: only absolute http, https and mailto links survive, always with
 * `target="_blank" rel="noopener noreferrer"`. Anything else (javascript:,
 * data:, relative, protocol-relative) becomes its plain text. Moodle
 * `pluginfile.php` links need her Moodle session to open, so they become
 * plain text too.
 *
 * Headings are moved down a level (h1/h2 to h3, h3 to h6 to h4) so a brief
 * never outranks the page it sits on.
 *
 * Server only: `sanitize-html` is large, so screens call `cleanBrief` on the
 * server and pass the result to the client `Brief` component.
 */
import sanitizeHtml from "sanitize-html";

declare const cleaned: unique symbol;

/** HTML that has been through `cleanHtml`. Only this module makes one. */
export type CleanHtml = string & { readonly [cleaned]: true };

export type CleanBrief = {
  readonly html: CleanHtml;
  /** True when pictures, video or embeds were removed. */
  readonly droppedMedia: boolean;
};

const ALLOWED_TAGS = [
  "h3", "h4", "h5", "h6",
  "p", "br", "hr", "blockquote", "div", "span",
  "ul", "ol", "li",
  "a",
  "strong", "b", "em", "i", "u", "s", "sub", "sup", "small", "mark",
  "code", "pre", "kbd",
  "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
];

/** Tags that carry pictures or embedded players. Dropped, and flagged. */
const MEDIA_TAGS = [
  "img", "picture", "video", "audio", "iframe", "object", "embed", "svg", "canvas", "source", "track",
];

/** Dropped together with any text inside them. */
const NON_TEXT_TAGS = [
  // sanitize-html's own defaults, kept.
  "script", "style", "textarea", "option", "xmp",
  "noscript", "template", "title", "head", "iframe", "object", "video", "audio",
  "svg", "math", "canvas", "select", "button", "noembed", "noframes",
];

const LINK_SCHEMES = ["http", "https", "mailto"];

const HEADING_MAP: Record<string, string> = {
  h1: "h3",
  h2: "h3",
  h3: "h4",
  h4: "h4",
  h5: "h4",
  h6: "h4",
};

/** True for an absolute http, https or mailto URL that is not a Moodle file link. */
function isSafeLink(href: string | undefined): href is string {
  if (!href) return false;
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return false; // relative or malformed
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!LINK_SCHEMES.includes(scheme)) return false;
  if (url.pathname.toLowerCase().includes("pluginfile.php")) return false;
  return true;
}

/** Clean a brief and report whether media was removed. */
export function cleanBrief(html: string): CleanBrief {
  let droppedMedia = false;

  const flagMedia: sanitizeHtml.Transformer = (tagName, attribs) => {
    droppedMedia = true;
    return { tagName, attribs };
  };

  const out = sanitizeHtml(html ?? "", {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "target", "rel"],
      th: ["colspan", "rowspan", "scope"],
      td: ["colspan", "rowspan"],
      ol: ["start"],
    },
    allowedSchemes: LINK_SCHEMES,
    allowedSchemesByTag: {},
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    allowedStyles: {},
    disallowedTagsMode: "discard",
    nonTextTags: NON_TEXT_TAGS,
    parseStyleAttributes: false,
    exclusiveFilter: (frame) => (frame.tag === "a" && !frame.attribs.href ? "excludeTag" : false),
    transformTags: {
      ...HEADING_MAP,
      ...Object.fromEntries(MEDIA_TAGS.map((tag) => [tag, flagMedia])),
      a: (_tagName, attribs): sanitizeHtml.Tag => {
        const href = attribs.href;
        // No href left: `exclusiveFilter` removes the tag and keeps its text.
        // (Renaming it to a disallowed tag instead trips a sanitize-html bug
        // that drops the closing tag of the next link at the same depth.)
        if (!isSafeLink(href)) return { tagName: "a", attribs: {} };
        return {
          tagName: "a",
          attribs: {
            href: href.trim(),
            target: "_blank",
            rel: "noopener noreferrer",
          },
        };
      },
    },
  });

  return { html: out.trim() as CleanHtml, droppedMedia };
}

/** Clean a brief and return only the HTML. */
export function cleanHtml(html: string): CleanHtml {
  return cleanBrief(html).html;
}
