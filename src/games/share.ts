/** Shareable result strings: copy to clipboard, or the native share sheet on phones. */
import { SITE_URL } from "../config";
import { toast } from "../ui/dom";

export function shareText(title: string, emoji: string, scoreLine: string, route: string): string {
  return `${title}\n${emoji}\n${scoreLine}\n${SITE_URL}#/${route}`;
}

export async function shareResult(text: string): Promise<void> {
  const mobile = matchMedia("(pointer: coarse)").matches;
  if (mobile && navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch {
      // cancelled or refused; fall through to copy
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Couldn't copy. Select the text and copy it manually.");
  }
}

/** Ten-square row for Quick 10 style tests: 🟩 right, 🟨 partial, ⬛ miss. */
export function squares(scores: number[]): string {
  return scores.map((s) => (s >= 100 ? "🟩" : s > 0 ? "🟨" : "⬛")).join("");
}
