// Безопасный рендер заметок Obsidian для голограммы. Без зависимостей — проверяется в node --test.
// Сначала каждая строка экранируется, и только потом размечается: HTML и скрипты из заметки не выполняются.
// Поддержано: свойства (frontmatter), заголовки, списки и задачи, цитаты и выноски > [!note], таблицы,
// блоки кода, **жирный**, *курсив*, ~~зачёркнутый~~, ==выделение==, `код`, [[ссылки|псевдоним]], #теги,
// [текст](https://…) — только http(s) и mailto.

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

// Строка уже экранирована (esc) — размечаем её. resolve(target) → путь заметки или null.
function inline(line, resolve, links) {
  const codes = [];
  let s = line.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/(!?)\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, embed, target, alias) => {
    const name = target.split(/[#^]/)[0].trim();
    const path = resolve(name);
    links.push(name);
    const label = alias || target;
    return `<a class="md-link${path ? "" : " md-missing"}" data-note="${name}"${path ? ` data-path="${esc(path)}"` : ""}>${embed ? "📎 " : ""}${label}</a>`;
  });
  s = s.replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const raw = url.replace(/&amp;/g, "&");
    return SAFE_URL.test(raw) ? `<a class="md-ext" href="${url}" target="_blank" rel="noopener noreferrer">${text || url}</a>` : text;
  });
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<b>${a ?? b}</b>`);
  s = s.replace(/(^|[^\p{L}\p{N}*])\*(?!\s)(.+?)\*(?![\p{L}\p{N}*])/gu, "$1<i>$2</i>");
  s = s.replace(/(^|[^\p{L}\p{N}_])_(?!\s)(.+?)_(?![\p{L}\p{N}_])/gu, "$1<i>$2</i>");
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>").replace(/==(.+?)==/g, "<mark>$1</mark>");
  s = s.replace(/(^|\s)#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu, '$1<span class="md-tag">#$2</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

function frontmatter(lines) {
  if (lines[0]?.trim() !== "---") return [null, 0];
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return [null, 0];
  const rows = lines.slice(1, end).filter((l) => l.trim()).map((l) => {
    const m = /^([^:\s][^:]*):\s*(.*)$/.exec(l);
    return m ? `<div><span>${esc(m[1].trim())}</span><b>${esc(m[2].trim()) || "—"}</b></div>` : `<div><b>${esc(l.trim())}</b></div>`;
  });
  return [rows.length ? `<div class="md-meta">${rows.join("")}</div>` : "", end + 1];
}

const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/** Markdown заметки → { html, links } (links — названия заметок из [[ссылок]]). */
export function renderMarkdown(src, { resolve = () => null } = {}) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const links = [];
  const out = [];
  const [meta, start] = frontmatter(lines);
  if (meta) out.push(meta);
  const il = (s) => inline(esc(s), resolve, links);
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.join("<br>")}</p>`); para = []; } };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(```|~~~)(.*)$/.exec(line))) {
      flush();
      const fence = m[1], body = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i]);
      out.push(`<pre class="md-code"><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); out.push(`<h${m[1].length}>${il(m[2])}</h${m[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push("<hr>"); continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const body = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ""));
      i--;
      const call = /^\[!(\w+)\][+-]?\s*(.*)$/.exec(body[0] || "");
      if (call) {
        const kind = call[1].toLowerCase();
        out.push(`<blockquote class="md-callout md-callout-${esc(kind)}"><div class="md-callout-t">${il(call[2] || call[1])}</div>`
          + `${body.slice(1).map(il).join("<br>")}</blockquote>`);
      } else out.push(`<blockquote>${body.map(il).join("<br>")}</blockquote>`);
      continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] || "")) {
      flush();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      i--;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${il(c)}</th>`).join("")}</tr></thead><tbody>`
        + rows.map((r) => `<tr>${r.map((c) => `<td>${il(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table></div>");
      continue;
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flush();
      const items = [];
      for (; i < lines.length && (m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])); i++) {
        const depth = Math.min(6, Math.floor(m[1].replace(/\t/g, "  ").length / 2));
        const task = /^\[([ xX\-/])\]\s*(.*)$/.exec(m[3]);
        const mark = /\d/.test(m[2]) ? `<span class="md-num">${esc(m[2])}</span>` : "";
        if (task) {
          const done = task[1] !== " ";
          items.push(`<li class="md-task${done ? " done" : ""}" data-line="${i}" style="--d:${depth}">`
            + `<span class="md-check" aria-hidden="true">${done ? "✓" : ""}</span>${il(task[2])}</li>`);
        } else items.push(`<li style="--d:${depth}">${mark}${il(m[3])}</li>`);
      }
      i--;
      out.push(`<ul class="md-list">${items.join("")}</ul>`);
      continue;
    }
    para.push(il(line.trim()));
  }
  flush();
  return { html: out.join("\n"), links: [...new Set(links)] };
}

/** Отметить задачу в строке lineIndex выполненной (или снять отметку) — как Obsidian Tasks: «✅ ГГГГ-ММ-ДД». */
export function toggleTask(text, lineIndex, today) {
  const lines = String(text).split("\n");
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](.*)$/.exec(lines[lineIndex] ?? "");
  if (!m) return null;
  const done = m[2] !== " ";
  const rest = done ? m[3].replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/, "") : `${m[3].replace(/\s+$/, "")} ✅ ${today}`;
  lines[lineIndex] = `${m[1]}[${done ? " " : "x"}]${rest}`;
  return lines.join("\n");
}
