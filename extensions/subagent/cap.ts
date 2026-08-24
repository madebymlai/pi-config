/**
 * Bounding text for wherever it is going: the parent model or a rendered entry. One
 * algorithm and one UTF-8 walk behind four named destinations, so a caller never
 * assembles a byte count, a line count and a marker at a call site.
 */

/** Where bounded text is going, and what that destination allows. */
export interface Destination {
  readonly bytes: number;
  /** Absent when the destination bounds bytes only. */
  readonly lines?: number;
  /** Appended verbatim and charged against both allowances. */
  readonly marker: string;
}

/** Everything the parent model sees from one child. */
export const MODEL_OUTPUT: Destination = {
  bytes: 48 * 1024,
  lines: 600,
  marker: "\n[output truncated by pi-subagent]",
};

/** One child's share of a parallel summary, which holds up to eight of them. */
export const PARALLEL_CHILD: Destination = {
  bytes: 12 * 1024,
  lines: 160,
  marker: MODEL_OUTPUT.marker,
};

/** Raw text one child hands to the next. Bytes only: a handoff is not reshaped by lines. */
export const HANDOFF: Destination = {
  bytes: 64 * 1024,
  marker: "\n\n[previous output truncated by pi-subagent]\n",
};

/** A side question's answer, which is rendered but never sent to the model. */
export const BTW: Destination = {
  bytes: 24 * 1024,
  lines: 600,
  marker: "\n[output truncated by /btw]",
};

/**
 * Largest slice end at or below `limit` that does not split a UTF-8 code point.
 * Continuation bytes match 0b10xxxxxx, so walk back off them before slicing.
 */
function utf8SafeEnd(bytes: Buffer, limit: number): number {
  let end = Math.min(bytes.length, Math.max(0, limit));
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}

/**
 * Bound `text` for `to`. Lines are trimmed before bytes, so a line-only overflow keeps
 * whole lines. Text that already fits is returned unchanged, so comparing the result
 * against the input is a reliable truncation signal: a bounded result always carries a
 * non-empty marker.
 */
export function cap(text: string, to: Destination = MODEL_OUTPUT): string {
  if (!text) return text;
  const lines = text.split("\n");
  const withinLines = to.lines === undefined || lines.length <= to.lines;
  if (withinLines && Buffer.byteLength(text, "utf8") <= to.bytes) return text;

  // One line of the allowance is reserved for the marker's own line.
  const kept = to.lines === undefined ? text : lines.slice(0, Math.max(0, to.lines - 1)).join("\n");
  const keptBytes = Buffer.from(kept, "utf8");
  const end = utf8SafeEnd(keptBytes, to.bytes - Buffer.byteLength(to.marker, "utf8"));
  return `${keptBytes.subarray(0, end).toString("utf8")}${to.marker}`;
}
