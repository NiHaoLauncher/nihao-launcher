// A small Markdown renderer for a project's description. Never injects HTML: the text is untrusted.

/** Stands for a `<br>` until the text is split into nodes. */
const LINE_BREAK = "\u0001";

/**
 * Modrinth descriptions are Markdown that may carry raw HTML (`<p>`, `<br>`, `<h2>`, `<img>`,
 * lists...). The block-level tags become the Markdown they stand for, so one renderer handles both;
 * every other tag is dropped later by `renderMarkdownInline`. Nothing here is ever injected as HTML.
 */
function htmlToMarkdown(body: string): string {
  const attr = (tag: string, name: string) =>
    new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find((v) => v !== undefined) ?? "";
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, LINE_BREAK)
    .replace(/<img\b[^>]*>/gi, (tag) => `![${attr(tag, "alt")}](${attr(tag, "src")})`)
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, tag, text) => `[${text}](${attr(tag, "href")})`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `\n\n${"#".repeat(Number(level))} ${text.trim()}\n\n`)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<hr\s*\/?>/gi, "\n\n---\n\n")
    .replace(/<\/?(p|div|center|section|details|summary|ul|ol|table|tr|blockquote)\b[^>]*>/gi, "\n\n");
}

/** Turns `&eacute;`, `&nbsp;`, `&#39;`... into their characters. A textarea decodes entities without running anything. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  const area = document.createElement("textarea");
  area.innerHTML = text;
  return area.value;
}

/**
 * Renders one run of inline Markdown (bold/italic/code/links/images) as React nodes, never
 * `dangerouslySetInnerHTML`: `body` is untrusted third-party text. Raw HTML tags are stripped, and
 * a link's text shows but not as a clickable `<a>` (it would navigate this webview away from the
 * app).
 */
/** `[ref]: url` definitions of the body being rendered, for reference-style images. */
let markdownRefs = new Map<string, string>();

function renderMarkdownInline(text: string, keyPrefix: string): React.ReactNode[] {
  const refs = markdownRefs;
  const stripped = decodeEntities(text.replace(/<[^>]+>/g, ""));
  // In order: linked image `[![alt](img)](url)`, image, link, bold, code, reference image/link `![alt][ref]` / `[text][ref]`, italic
  const pattern = /\[!\[([^\]]*)\]\(([^)]+)\)\]\([^)]+\)|!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]*)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(!?)\[([^\]]*)\]\[([^\]]*)\]|\*([^*\n]+)\*/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let i = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    if (match.index > lastIndex) nodes.push(stripped.slice(lastIndex, match.index));
    if (match[2] !== undefined) {
      nodes.push(<img key={`${keyPrefix}-${i++}`} className="modpack-project-inline-image" src={match[2]} alt={match[1]} />);
    } else if (match[4] !== undefined) {
      nodes.push(<img key={`${keyPrefix}-${i++}`} className="modpack-project-inline-image" src={match[4]} alt={match[3]} />);
    } else if (match[6] !== undefined) {
      nodes.push(<span key={`${keyPrefix}-${i++}`} className="modpack-project-link-text">{match[5]}</span>);
    } else if (match[7] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${i++}`}>{match[7]}</strong>);
    } else if (match[8] !== undefined) {
      nodes.push(<code key={`${keyPrefix}-${i++}`}>{match[8]}</code>);
    } else if (match[12] !== undefined) {
      nodes.push(<em key={`${keyPrefix}-${i++}`}>{match[12]}</em>);
    } else if (match[10] !== undefined) {
      const url = refs.get((match[11] || match[10]).toLowerCase());
      if (match[9] && url) nodes.push(<img key={`${keyPrefix}-${i++}`} className="modpack-project-inline-image" src={url} alt={match[10]} />);
      else if (!match[9]) nodes.push(<span key={`${keyPrefix}-${i++}`} className="modpack-project-link-text">{match[10]}</span>);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < stripped.length) nodes.push(stripped.slice(lastIndex));
  // A `<br>` was turned into a marker; it becomes a real line break again here.
  return nodes.flatMap((node, n): React.ReactNode[] =>
    typeof node !== "string" || !node.includes(LINE_BREAK)
      ? [node]
      : node.split(LINE_BREAK).flatMap((part, k): React.ReactNode[] => (k === 0 ? [part] : [<br key={`${keyPrefix}-br-${n}-${k}`} />, part])),
  );
}

/** A small, safe, from-scratch Markdown-ish renderer for `ProjectDetail.body` — covers headers,
 *  paragraphs, `-`/`*`/numbered lists, quotes, fenced code blocks, image lines, and `---` rules,
 *  and the HTML a Modrinth description sometimes uses instead (see `htmlToMarkdown`), without
 *  pulling in a full CommonMark dependency (and without ever trusting raw HTML — see
 *  `renderMarkdownInline`). */
export function renderMarkdownBody(body: string): React.ReactNode[] {
  markdownRefs = new Map();
  const lines = htmlToMarkdown(body).replace(/\r\n/g, "\n").split("\n").filter((line) => {
    const def = /^\s*\[([^\]]+)\]:\s*(\S+)/.exec(line);
    if (def) markdownRefs.set(def[1].toLowerCase(), def[2]);
    return !def;
  });
  const blocks: React.ReactNode[] = [];
  let listBuffer: string[] = [];
  let paraBuffer: string[] = [];
  let codeBuffer: string[] = [];
  let inCodeFence = false;
  let key = 0;

  const flushList = () => {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];
    blocks.push(
      <ul key={`ul-${key++}`} className="modpack-project-list">
        {items.map((item, i) => <li key={i}>{renderMarkdownInline(item, `li-${key}-${i}`)}</li>)}
      </ul>
    );
  };
  const flushPara = () => {
    if (paraBuffer.length === 0) return;
    const text = paraBuffer.join(" ");
    paraBuffer = [];
    blocks.push(<p key={`p-${key++}`}>{renderMarkdownInline(text, `p-${key}`)}</p>);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      if (inCodeFence) {
        blocks.push(<pre key={`code-${key++}`} className="modpack-project-code">{codeBuffer.join("\n")}</pre>);
        codeBuffer = [];
        inCodeFence = false;
      } else {
        flushPara();
        flushList();
        inCodeFence = true;
      }
      continue;
    }
    if (inCodeFence) {
      codeBuffer.push(rawLine);
      continue;
    }

    if (line === "") {
      flushPara();
      flushList();
      continue;
    }

    const headerMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headerMatch) {
      flushPara();
      flushList();
      const level = Math.min(headerMatch[1].length + 2, 6);
      const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={`h-${key++}`} className="modpack-project-heading">{renderMarkdownInline(headerMatch[2], `h-${key}`)}</Tag>);
      continue;
    }

    const imageOnlyMatch = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
    if (imageOnlyMatch) {
      flushPara();
      flushList();
      blocks.push(<img key={`img-${key++}`} className="modpack-project-image" src={imageOnlyMatch[2]} alt={imageOnlyMatch[1]} />);
      continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      flushPara();
      listBuffer.push(line.slice(2));
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushPara();
      listBuffer.push(numbered[1]);
      continue;
    }
    if (line.startsWith("> ")) {
      flushPara();
      flushList();
      blocks.push(<blockquote key={`q-${key++}`} className="modpack-project-quote">{renderMarkdownInline(line.slice(2), `q-${key}`)}</blockquote>);
      continue;
    }

    if (/^-{3,}$/.test(line) || /^\*{3,}$/.test(line)) {
      flushPara();
      flushList();
      blocks.push(<hr key={`hr-${key++}`} />);
      continue;
    }

    flushList();
    paraBuffer.push(line);
  }
  flushPara();
  flushList();
  if (inCodeFence && codeBuffer.length > 0) {
    blocks.push(<pre key={`code-${key++}`} className="modpack-project-code">{codeBuffer.join("\n")}</pre>);
  }
  return blocks;
}
