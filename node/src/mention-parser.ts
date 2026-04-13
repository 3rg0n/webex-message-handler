/**
 * Parse Webex `<spark-mention>` tags from decrypted HTML to extract
 * mentioned people and groups.
 */

export interface ParsedMentions {
  mentionedPeople: string[];
  mentionedGroups: string[];
}

const MENTION_RE = /<spark-mention[^>]*data-object-type="([^"]*)"[^>]*>/gi;
const PERSON_ID_RE = /data-object-id="([^"]*)"/i;
const GROUP_TYPE_RE = /data-group-type="([^"]*)"/i;

export function parseMentions(html: string | undefined | null): ParsedMentions {
  const result: ParsedMentions = { mentionedPeople: [], mentionedGroups: [] };
  if (!html) return result;

  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  // Reset regex lastIndex
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(html)) !== null) {
    const tag = match[0];
    const objectType = match[1];

    if (objectType === 'person') {
      const idMatch = PERSON_ID_RE.exec(tag);
      if (idMatch && idMatch[1] && !seen.has(idMatch[1])) {
        seen.add(idMatch[1]);
        result.mentionedPeople.push(idMatch[1]);
      }
    } else if (objectType === 'groupMention') {
      const groupMatch = GROUP_TYPE_RE.exec(tag);
      if (groupMatch && groupMatch[1] && !seen.has(`group:${groupMatch[1]}`)) {
        seen.add(`group:${groupMatch[1]}`);
        result.mentionedGroups.push(groupMatch[1]);
      }
    }
  }

  return result;
}
