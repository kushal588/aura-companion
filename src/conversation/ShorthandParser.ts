import { isEmotion, isVoicePace } from '../types/emotion';

/**
 * Authoring shorthand parser (PLAN §6.3).
 *
 * `$excited$ #cheerful# "You finished it? That's fantastic!"` is convenient to
 * write by hand and to debug with, but it is not the runtime protocol. This
 * parser converts it into the same internal representation the structured
 * output uses, and removes the tags before anything is displayed, spoken or
 * logged.
 *
 * Escaping: `\$` and `\#` are literal. Anything inside quotes in the *user's*
 * own text is never interpreted — only assistant output is parsed.
 */

export interface ParsedShorthandSegment {
  text: string;
  emotion?: string;
  voiceStyle?: string;
  pace?: string;
}

export interface ShorthandParseResult {
  segments: ParsedShorthandSegment[];
  /** True when at least one tag was recognised. */
  hadTags: boolean;
}

const TAG = /([$#])([a-z_]{2,24})\1/gi;

export function parseShorthand(input: string): ShorthandParseResult {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const segments: ParsedShorthandSegment[] = [];
  let hadTags = false;

  for (const line of lines) {
    const segment: ParsedShorthandSegment = { text: '' };
    let lastIndex = 0;
    let remaining = line.replace(TAG, (match, sigil: string, rawValue: string, offset: number) => {
      const relative = offset - lastIndex;
      const consumed = line.slice(lastIndex, offset);
      lastIndex = offset + match.length;
      void relative;
      void consumed;
      const value = rawValue.toLowerCase();
      if (sigil === '$') {
        if (isEmotion(value)) {
          segment.emotion = value;
          hadTags = true;
          return '';
        }
        return match;
      }
      // `#` carries a voice style / pace hint rather than an emotion.
      if (isVoicePace(value)) {
        segment.pace = value;
        hadTags = true;
        return '';
      }
      segment.voiceStyle = value.replace(/_/g, ' ');
      hadTags = true;
      return '';
    });

    remaining = remaining.replace(/\s{2,}/g, ' ').trim();
    const unquoted = remaining.replace(/^["'“”](.*)["'“”]$/s, '$1').trim();
    if (!unquoted) continue;
    segment.text = unquoted;
    segments.push(segment);
  }

  return { segments, hadTags };
}

/** Remove tags from text that will be shown to the user. */
export function removeShorthand(input: string): string {
  return input.replace(TAG, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Neutralise tag-like sequences in *user* text so they can never be interpreted
 * as controls, including inside quoted material (PLAN §6.3).
 */
export function escapeShorthand(input: string): string {
  return input.replace(TAG, (match) => `\\${match}`);
}
