import type { Task } from "../../shared/types";

export function formatTaskStatus(task: Task): { html: string; plain: string } {
  const statusEmoji: Record<string, string> = {
    pending: "[ ]",
    indexing: "[..]",
    planning: "[..]",
    implementing: "[..]",
    linting: "[..]",
    fix_linting: "[..]",
    ci_running: "[..]",
    ci_fixing: "[..]",
    review: "[??]",
    waiting_for_input: "[??]",
    accepted: "[OK]",
    committed: "[OK]",
    failed: "[!!]",
    cancelled: "[--]",
  };

  const marker = statusEmoji[task.status] ?? "[??]";

  const plain = `${marker} ${task.title} (${task.id.slice(0, 8)}) -- ${task.status}`;
  const html = `<b>${marker}</b> ${escapeHtml(task.title)} <code>${task.id.slice(0, 8)}</code> -- <i>${task.status}</i>`;

  return { html, plain };
}

export function formatCodeBlock(content: string, language?: string): { html: string; plain: string } {
  const plain = `\`\`\`${language ?? ""}\n${content}\n\`\`\``;
  const html = `<pre><code class="language-${language ?? ""}">${escapeHtml(content)}</code></pre>`;
  return { html, plain };
}

export function formatReviewLink(url: string): { html: string; plain: string } {
  const plain = `Review: ${url}`;
  const html = `Review: <a href="${url}">${url}</a>`;
  return { html, plain };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
