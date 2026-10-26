import { TextStyle } from "zca-js";

// Dấu hiệu nhận biết văn bản là markdown (tiêu đề, danh sách, trích dẫn, code, in đậm, link...).
const MD_HINT =
  /(^|\n) {0,3}(#{1,6} |[-*+] |\d+[.)] |> ?|```|(-{3,}|\*{3,}|_{3,}) *(\n|$))|\*\*\S[^\n]*?\*\*|__\S[^\n]*?__|~~\S[^\n]*?~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/;

export const looksLikeMarkdown = (text) => MD_HINT.test(text);

const DELIMS = [
  { mark: "***", st: [TextStyle.Bold, TextStyle.Italic] },
  { mark: "**", st: [TextStyle.Bold] },
  { mark: "__", st: [TextStyle.Bold] },
  { mark: "~~", st: [TextStyle.StrikeThrough] },
  { mark: "*", st: [TextStyle.Italic] },
  { mark: "_", st: [TextStyle.Italic] },
];
const WORD = /[\p{L}\p{N}]/u;
const ESCAPABLE = /[\\`*_~[\]()#>+\-.!|]/;

/** Tìm dấu đóng của `mark` bắt đầu từ `from`; trả về -1 nếu không có. */
function findClose(src, from, mark) {
  for (let j = from; j <= src.length - mark.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (!src.startsWith(mark, j) || /\s/.test(src[j - 1])) continue;
    if (mark.length === 1 && src[j + 1] === mark) {
      j++; // bỏ qua "**" / "__" khi đang tìm "*" / "_"
      continue;
    }
    if (mark[0] === "_" && WORD.test(src[j + mark.length] ?? "")) continue;
    return j;
  }
  return -1;
}

/** Chuyển markdown trong một dòng thành văn bản thuần + styles (vị trí tính từ đầu dòng). */
function parseInline(src) {
  let text = "";
  const styles = [];
  const append = (part) => {
    for (const s of part.styles) styles.push({ ...s, start: s.start + text.length });
    text += part.text;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === "\\" && ESCAPABLE.test(src[i + 1] ?? "")) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        text += src.slice(i + 1, end); // Zalo không có font monospace -> giữ nguyên nội dung
        i = end + 1;
        continue;
      }
    }

    if (c === "[" || (c === "!" && src[i + 1] === "[")) {
      const m = /^!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
      if (m) {
        const label = parseInline(m[1]);
        append(label);
        if (!label.text) text += m[2];
        else if (label.text !== m[2]) text += ` (${m[2]})`;
        i += m[0].length;
        continue;
      }
    }

    const d = DELIMS.find((d) => src.startsWith(d.mark, i));
    if (d) {
      const next = src[i + d.mark.length] ?? "";
      const canOpen = next && !/\s/.test(next) && !(d.mark[0] === "_" && WORD.test(src[i - 1] ?? ""));
      const end = canOpen ? findClose(src, i + d.mark.length + 1, d.mark) : -1;
      if (end > 0) {
        const inner = parseInline(src.slice(i + d.mark.length, end));
        const start = text.length;
        append(inner);
        if (inner.text.length) for (const st of d.st) styles.push({ start, len: inner.text.length, st });
        i = end + d.mark.length;
        continue;
      }
      text += d.mark; // không có dấu đóng -> giữ nguyên ký tự
      i += d.mark.length;
      continue;
    }

    text += c;
    i++;
  }
  return { text, styles };
}

/**
 * Chuyển markdown sang định dạng tin nhắn Zalo: văn bản thuần + `styles` (đậm, nghiêng, gạch, cỡ chữ).
 * Danh sách dùng ký tự "•" và số thứ tự trong văn bản để hiển thị giống nhau trên mọi thiết bị.
 */
export function markdownToZalo(md) {
  let msg = "";
  const styles = [];
  let lines = 0;
  let blank = false;
  const pushLine = (prefix, part, lineStyles = []) => {
    const isBlank = !prefix && !part.text.trim();
    if (isBlank && (blank || !lines)) return; // bỏ dòng trống ở đầu và dòng trống liên tiếp
    blank = isBlank;
    if (lines++) msg += "\n";
    msg += prefix;
    const base = msg.length;
    for (const s of part.styles) styles.push({ ...s, start: s.start + base });
    for (const st of lineStyles) if (part.text.length) styles.push({ start: base, len: part.text.length, st });
    msg += part.text;
  };

  let fence = null;
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      else pushLine("", { text: line, styles: [] });
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }

    let m;
    if ((m = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line))) {
      const level = m[1].length;
      pushLine("", parseInline(m[2]), level <= 2 ? [TextStyle.Bold, TextStyle.Big] : [TextStyle.Bold]);
    } else if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) {
      pushLine("", { text: "──────────", styles: [] });
    } else if ((m = /^( *)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line))) {
      pushLine(`${m[1]}${m[2] === " " ? "☐" : "☑"} `, parseInline(m[3]));
    } else if ((m = /^( *)[-*+]\s+(.*)$/.exec(line))) {
      pushLine(`${m[1]}• `, parseInline(m[2]));
    } else if ((m = /^( *)(\d+)[.)]\s+(.*)$/.exec(line))) {
      pushLine(`${m[1]}${m[2]}. `, parseInline(m[3]));
    } else if ((m = /^ {0,3}>\s?(.*)$/.exec(line))) {
      pushLine("▎ ", parseInline(m[1]), [TextStyle.Italic]);
    } else {
      pushLine("", parseInline(line.replace(/ {2,}$/, "")));
    }
  }

  return { msg: msg.trimEnd(), styles };
}
