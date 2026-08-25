/**
 * What a renderer is allowed to know about its host.
 *
 * pi hands renderers a large theme object. Declaring the three functions they
 * actually use turns that into a seam: a test supplies a fake that returns its
 * input unchanged, and assertions read as plain strings rather than escape codes.
 *
 * `expandHint` is here for a sharper reason. The renderers used to call pi's
 * keyHint() directly, which reads process-global theme state and throws when it
 * has not been initialised. That made the entire collapsed branch of every
 * renderer unreachable outside a live pi session, which is why the one test that
 * existed only ever passed expanded: true. Taking the hint as a value moves that
 * lookup to the registration site, where a live pi is a given.
 */
export interface RenderTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

/** Everything a renderer needs from the host beyond its own details. */
export interface RenderContext {
  theme: RenderTheme;
  /**
   * The "press X to expand" hint, as a thunk.
   *
   * A thunk rather than a string because resolving it touches pi's global theme
   * state, and only the collapsed branch needs it. Evaluating eagerly would make
   * even an expanded render depend on a live pi session. Same reason the spawn
   * environment in spawn/guard.ts takes thunks.
   */
  expandHint: () => string;
  /** Whether the reader has opened this message. */
  expanded: boolean;
  /** Total columns available, borders included. */
  width: number;
}

/**
 * A message's details as a readable record, or null when it is not one.
 *
 * Every renderer needs this before it can look at a field: pi hands details
 * through as unknown, and a message that is not ours can be anything at all.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

/** A theme that paints nothing, for plain-text rendering and for tests. */
export const UNPAINTED: RenderTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};
