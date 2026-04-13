package webexmessagehandler

import "regexp"

// ParsedMentions holds person and group mentions extracted from message HTML.
type ParsedMentions struct {
	MentionedPeople []string
	MentionedGroups []string
}

var (
	mentionRe   = regexp.MustCompile(`(?i)<spark-mention[^>]*data-object-type="([^"]*)"[^>]*>`)
	personIDRe  = regexp.MustCompile(`(?i)data-object-id="([^"]*)"`)
	groupTypeRe = regexp.MustCompile(`(?i)data-group-type="([^"]*)"`)
)

// ParseMentions extracts mentioned people and groups from decrypted HTML.
//
// Parses <spark-mention> tags to find person UUIDs and group mention types
// (e.g. "all"). Duplicates are removed.
func ParseMentions(html string) ParsedMentions {
	result := ParsedMentions{}
	if html == "" {
		return result
	}

	seen := make(map[string]bool)

	matches := mentionRe.FindAllStringSubmatch(html, -1)
	allTags := mentionRe.FindAllString(html, -1)

	for i, match := range matches {
		objectType := match[1]
		tag := allTags[i]

		if objectType == "person" {
			idMatch := personIDRe.FindStringSubmatch(tag)
			if len(idMatch) > 1 && idMatch[1] != "" && !seen[idMatch[1]] {
				seen[idMatch[1]] = true
				result.MentionedPeople = append(result.MentionedPeople, idMatch[1])
			}
		} else if objectType == "groupMention" {
			groupMatch := groupTypeRe.FindStringSubmatch(tag)
			if len(groupMatch) > 1 && groupMatch[1] != "" {
				key := "group:" + groupMatch[1]
				if !seen[key] {
					seen[key] = true
					result.MentionedGroups = append(result.MentionedGroups, groupMatch[1])
				}
			}
		}
	}

	return result
}
