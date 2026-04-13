"""Parse Webex ``<spark-mention>`` tags from decrypted HTML."""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class ParsedMentions:
    """Mentions extracted from message HTML."""

    mentioned_people: list[str] = field(default_factory=list)
    mentioned_groups: list[str] = field(default_factory=list)


_MENTION_RE = re.compile(
    r'<spark-mention[^>]*data-object-type="([^"]*)"[^>]*>', re.IGNORECASE
)
_PERSON_ID_RE = re.compile(r'data-object-id="([^"]*)"', re.IGNORECASE)
_GROUP_TYPE_RE = re.compile(r'data-group-type="([^"]*)"', re.IGNORECASE)


def parse_mentions(html: str | None) -> ParsedMentions:
    """Extract mentioned people and groups from decrypted HTML.

    Parses ``<spark-mention>`` tags to find person UUIDs and group
    mention types (e.g. ``"all"``). Duplicates are removed.

    Args:
        html: Decrypted HTML content from a Webex message.

    Returns:
        ParsedMentions with ``mentioned_people`` and ``mentioned_groups``.
    """
    result = ParsedMentions()
    if not html:
        return result

    seen: set[str] = set()

    for match in _MENTION_RE.finditer(html):
        tag = match.group(0)
        object_type = match.group(1)

        if object_type == "person":
            id_match = _PERSON_ID_RE.search(tag)
            if id_match and id_match.group(1) and id_match.group(1) not in seen:
                seen.add(id_match.group(1))
                result.mentioned_people.append(id_match.group(1))
        elif object_type == "groupMention":
            group_match = _GROUP_TYPE_RE.search(tag)
            if group_match and group_match.group(1):
                key = f"group:{group_match.group(1)}"
                if key not in seen:
                    seen.add(key)
                    result.mentioned_groups.append(group_match.group(1))

    return result
