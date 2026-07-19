import { parseMentions } from '../src/mention-parser.js';

describe('parseMentions', () => {
  it('returns empty for null/undefined/empty input', () => {
    expect(parseMentions(null)).toEqual({ mentionedPeople: [], mentionedGroups: [] });
    expect(parseMentions(undefined)).toEqual({ mentionedPeople: [], mentionedGroups: [] });
    expect(parseMentions('')).toEqual({ mentionedPeople: [], mentionedGroups: [] });
  });

  it('extracts a single person mention', () => {
    const html =
      '<spark-mention data-object-type="person" data-object-id="uuid-1">Alice</spark-mention>';
    expect(parseMentions(html)).toEqual({
      mentionedPeople: ['uuid-1'],
      mentionedGroups: [],
    });
  });

  it('extracts multiple person mentions and dedupes', () => {
    const html =
      '<spark-mention data-object-type="person" data-object-id="uuid-1">A</spark-mention>' +
      '<spark-mention data-object-type="person" data-object-id="uuid-2">B</spark-mention>' +
      '<spark-mention data-object-type="person" data-object-id="uuid-1">A again</spark-mention>';
    expect(parseMentions(html).mentionedPeople).toEqual(['uuid-1', 'uuid-2']);
  });

  it('extracts a group mention', () => {
    const html =
      '<spark-mention data-object-type="groupMention" data-group-type="all">All</spark-mention>';
    expect(parseMentions(html)).toEqual({
      mentionedPeople: [],
      mentionedGroups: ['all'],
    });
  });

  it('handles mixed person and group mentions regardless of attribute order', () => {
    const html =
      '<spark-mention data-object-id="uuid-9" data-object-type="person">X</spark-mention>' +
      '<spark-mention data-group-type="all" data-object-type="groupMention">All</spark-mention>';
    const result = parseMentions(html);
    expect(result.mentionedPeople).toEqual(['uuid-9']);
    expect(result.mentionedGroups).toEqual(['all']);
  });

  it('ignores non-mention HTML', () => {
    expect(parseMentions('<p>hello <b>world</b></p>')).toEqual({
      mentionedPeople: [],
      mentionedGroups: [],
    });
  });

  // Regression guard for CodeQL js/polynomial-redos (high). The previous regex
  // used two `[^>]*` around the attribute, which backtracked polynomially on
  // crafted input. This pathological string must parse near-instantly.
  it('does not exhibit polynomial backtracking on crafted input (ReDoS guard)', () => {
    const evil = '<spark-mention' + ' data-object-type="'.repeat(50000);
    const start = Date.now();
    const result = parseMentions(evil);
    const elapsed = Date.now() - start;
    expect(result).toEqual({ mentionedPeople: [], mentionedGroups: [] });
    expect(elapsed).toBeLessThan(1000);
  });
});
