import { BTW, cap } from "./cap.js";
import { getFinalText, type ChildResult } from "./engine/index.js";

export interface BtwResultData {
  id: string;
  title: string;
  status: "completed" | "failed";
  prompt: string;
  answer: string;
  error?: string;
  truncated: boolean;
  model?: string;
}

/** Derive a compact, Unicode-safe title from the first meaningful prompt line. */
export function deriveBtwTitle(question: string): string {
  const firstLine = question.split("\n").find((line) => line.trim());
  const title = firstLine?.trim().replace(/\s+/g, " ") || "by the way";
  const codePoints = Array.from(title);
  return codePoints.length <= 60 ? title : `${codePoints.slice(0, 59).join("")}…`;
}

export function createBtwResultData(
  id: string,
  title: string,
  prompt: string,
  result: ChildResult,
): BtwResultData {
  const error = result.errorMessage;
  const raw = error ?? getFinalText(result);
  // A bounded result always gains a marker, so this comparison cannot read false.
  const answer = cap(raw, BTW);
  return {
    id,
    title,
    status: error ? "failed" : "completed",
    prompt,
    answer,
    error: error ? answer : undefined,
    truncated: answer !== raw,
    model: result.model,
  };
}
