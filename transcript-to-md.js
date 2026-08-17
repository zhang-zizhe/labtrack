/**
 * Turn a Claude Code session transcript (.jsonl) into a readable Markdown log.
 *
 * The raw file is mostly machine noise — base64 screenshots, whole-file reads,
 * duplicated tool results — so a straight dump would be 22 MB of unreadable
 * scrollback. This keeps what a person would want to reread: what was asked,
 * what was said back, and a one-line trace of the work in between.
 *
 *   node to-md.js <transcript.jsonl> <out.md> [--thinking] [--full-output]
 */
const fs = require("fs");
const readline = require("readline");

const [, , SRC, OUT, ...flags] = process.argv;
const KEEP_THINKING = flags.includes("--thinking");
const FULL_OUTPUT = flags.includes("--full-output");
const RESULT_CHARS = FULL_OUTPUT ? 100000 : 700;

if (!SRC || !OUT) {
  console.error("usage: node to-md.js <transcript.jsonl> <out.md> [--thinking] [--full-output]");
  process.exit(1);
}

// System-injected blocks are context plumbing, not conversation. Reminders and
// command stdout are the two that show up inside user turns and read as if the
// user typed them, which they did not.
const stripNoise = t =>
  String(t)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .trim();

const fence = (s, lang = "") => "```" + lang + "\n" + s.replace(/```/g, "``​`") + "\n```";

const clip = (s, n) => {
  s = String(s == null ? "" : s);
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n… [${s.length - n} more characters]`;
};

// One line describing a tool call. The interesting field differs per tool, and a
// generic JSON dump of the input buries it under style objects and file bodies.
function describeCall(name, input) {
  const i = input || {};
  switch (name) {
    case "Bash":            return { label: i.description || "shell", body: i.command, lang: "bash" };
    case "Read":            return { label: `read \`${i.file_path}\`` + (i.offset ? ` (from line ${i.offset})` : "") };
    case "Write":           return { label: `write \`${i.file_path}\``, body: clip(i.content, 400) };
    case "Edit":            return { label: `edit \`${i.file_path}\`` };
    case "Grep":            return { label: `grep \`${i.pattern}\`` + (i.path ? ` in \`${i.path}\`` : "") };
    case "Glob":            return { label: `glob \`${i.pattern}\`` };
    case "TodoWrite":       return { label: "update todos" };
    case "Task":
    case "Agent":           return { label: `subagent: ${i.description || i.subagent_type || ""}` };
    case "ToolSearch":      return { label: `load tools: \`${i.query}\`` };
    case "AskUserQuestion": return { label: "ask the user", body: (i.questions || []).map(q => "- " + q.question).join("\n") };
    case "ExitPlanMode":    return { label: "present plan for approval" };
    default:
      if (name.startsWith("mcp__claude-in-chrome__")) {
        const t = name.replace("mcp__claude-in-chrome__", "");
        if (t === "computer")        return { label: `browser: ${i.action}${i.text ? ` "${clip(i.text, 60)}"` : ""}${i.coordinate ? ` at (${i.coordinate})` : ""}` };
        if (t === "navigate")        return { label: `browser: navigate to ${i.url}` };
        if (t === "find")            return { label: `browser: find "${i.query}"` };
        if (t === "javascript_tool") return { label: "browser: run script", body: clip(i.text, 900), lang: "js" };
        if (t === "read_console_messages") return { label: "browser: read console" };
        return { label: `browser: ${t}` };
      }
      return { label: name, body: clip(JSON.stringify(i, null, 1), 400), lang: "json" };
  }
}

// Tool results carry the bulk of the 22 MB. Images are dropped outright; text is
// clipped, because the point of the log is the conversation, not the scrollback.
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(c => (c.type === "text" ? c.text : c.type === "image" ? "[screenshot]" : ""))
    .filter(Boolean)
    .join("\n");
}

const out = [];
const callsById = new Map();   // tool_use_id -> tool name, so a result can name its call
let userTurns = 0, assistantTurns = 0, toolCalls = 0, firstTs = null, lastTs = null;

const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });

rl.on("line", line => {
  if (!line.trim()) return;
  let o;
  try { o = JSON.parse(line); } catch { return; }
  if (o.type !== "user" && o.type !== "assistant") return;
  const m = o.message;
  if (!m) return;
  if (o.timestamp) { firstTs = firstTs || o.timestamp; lastTs = o.timestamp; }

  const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content || []);

  if (m.role === "user") {
    // A "user" record is either something the person typed or a tool result
    // being fed back. Only the former is conversation.
    const texts = parts.filter(p => p.type === "text").map(p => stripNoise(p.text)).filter(Boolean);
    const results = parts.filter(p => p.type === "tool_result");

    for (const r of results) {
      const name = callsById.get(r.tool_use_id) || "tool";
      // Browser and file results carry system-reminder blocks of their own.
      const body = clip(stripNoise(resultText(r.content)), RESULT_CHARS);
      if (!body) continue;
      out.push(`<details><summary>result — ${name}${r.is_error ? " (error)" : ""}</summary>\n\n${fence(body)}\n\n</details>\n`);
    }
    for (const t of texts) {
      if (t.startsWith("This session is being continued")) {
        out.push(`> _[context was compacted here; the summary that carried over is omitted]_\n`);
        continue;
      }
      userTurns++;
      out.push(`\n---\n\n## 👤 ${userTurns}\n\n${t}\n`);
    }
    return;
  }

  // assistant
  let wroteHeader = false;
  const header = () => {
    if (!wroteHeader) { out.push(`\n### 🤖\n`); wroteHeader = true; }
  };
  if (parts.some(p => p.type === "text" && p.text && p.text.trim())) assistantTurns++;

  for (const p of parts) {
    if (p.type === "thinking" && KEEP_THINKING && p.thinking && p.thinking.trim()) {
      header();
      out.push(`<details><summary>thinking</summary>\n\n${p.thinking.trim()}\n\n</details>\n`);
    } else if (p.type === "text" && p.text && p.text.trim()) {
      header();
      out.push(p.text.trim() + "\n");
    } else if (p.type === "tool_use") {
      header();
      toolCalls++;
      callsById.set(p.id, p.name);
      const d = describeCall(p.name, p.input);
      out.push(`**▸ ${d.label}**\n`);
      if (d.body && String(d.body).trim()) out.push(fence(String(d.body).trim(), d.lang || "") + "\n");
    }
  }
});

rl.on("close", () => {
  const head = [
    "# LabTrack — Alliance AI Lab · session log",
    "",
    `_${userTurns} messages from the user, ${assistantTurns} replies, ${toolCalls} tool calls._`,
    firstTs ? `_${firstTs.slice(0, 16).replace("T", " ")} → ${lastTs.slice(0, 16).replace("T", " ")} UTC_` : "",
    "",
    "> Generated from the Claude Code session transcript. Tool output is clipped —",
    "> screenshots and whole-file reads are omitted — so this stays readable. The",
    "> authoritative record of what changed is the git history.",
    "",
  ].join("\n");
  fs.writeFileSync(OUT, head + out.join("\n"));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`${OUT} — ${kb} KB · ${userTurns} user messages · ${assistantTurns} replies · ${toolCalls} tool calls`);
});
