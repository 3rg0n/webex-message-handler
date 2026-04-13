//! Parse Webex `<spark-mention>` tags from decrypted HTML.

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashSet;

/// Mentions extracted from message HTML.
#[derive(Debug, Clone, Default)]
pub struct ParsedMentions {
    /// Person UUIDs mentioned via @mention in the message.
    pub mentioned_people: Vec<String>,
    /// Group mention types (e.g. "all") in the message.
    pub mentioned_groups: Vec<String>,
}

static MENTION_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)<spark-mention[^>]*data-object-type="([^"]*)"[^>]*>"#).unwrap()
});

static PERSON_ID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)data-object-id="([^"]*)""#).unwrap()
});

static GROUP_TYPE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)data-group-type="([^"]*)""#).unwrap()
});

/// Extract mentioned people and groups from decrypted HTML.
///
/// Parses `<spark-mention>` tags to find person UUIDs and group mention
/// types (e.g. "all"). Duplicates are removed.
pub fn parse_mentions(html: Option<&str>) -> ParsedMentions {
    let mut result = ParsedMentions::default();
    let html = match html {
        Some(h) if !h.is_empty() => h,
        _ => return result,
    };

    let mut seen = HashSet::new();

    for cap in MENTION_RE.captures_iter(html) {
        let tag = cap.get(0).unwrap().as_str();
        let object_type = &cap[1];

        if object_type == "person" {
            if let Some(id_cap) = PERSON_ID_RE.captures(tag) {
                let id = &id_cap[1];
                if !id.is_empty() && seen.insert(id.to_string()) {
                    result.mentioned_people.push(id.to_string());
                }
            }
        } else if object_type == "groupMention" {
            if let Some(group_cap) = GROUP_TYPE_RE.captures(tag) {
                let group_type = &group_cap[1];
                if !group_type.is_empty() && seen.insert(format!("group:{group_type}")) {
                    result.mentioned_groups.push(group_type.to_string());
                }
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_person_mention() {
        let html = r#"<p><spark-mention data-object-type="person" data-object-id="abc-123">Alice</spark-mention> hello</p>"#;
        let m = parse_mentions(Some(html));
        assert_eq!(m.mentioned_people, vec!["abc-123"]);
        assert!(m.mentioned_groups.is_empty());
    }

    #[test]
    fn test_group_mention() {
        let html = r#"<p><spark-mention data-object-type="groupMention" data-group-type="all">All</spark-mention> hello</p>"#;
        let m = parse_mentions(Some(html));
        assert!(m.mentioned_people.is_empty());
        assert_eq!(m.mentioned_groups, vec!["all"]);
    }

    #[test]
    fn test_mixed_mentions() {
        let html = r#"<p><spark-mention data-object-type="person" data-object-id="p1">Alice</spark-mention> and <spark-mention data-object-type="groupMention" data-group-type="all">All</spark-mention></p>"#;
        let m = parse_mentions(Some(html));
        assert_eq!(m.mentioned_people, vec!["p1"]);
        assert_eq!(m.mentioned_groups, vec!["all"]);
    }

    #[test]
    fn test_duplicate_dedup() {
        let html = r#"<spark-mention data-object-type="person" data-object-id="p1">A</spark-mention> <spark-mention data-object-type="person" data-object-id="p1">A</spark-mention>"#;
        let m = parse_mentions(Some(html));
        assert_eq!(m.mentioned_people, vec!["p1"]);
    }

    #[test]
    fn test_empty_html() {
        let m = parse_mentions(None);
        assert!(m.mentioned_people.is_empty());
        assert!(m.mentioned_groups.is_empty());
    }

    #[test]
    fn test_no_mentions() {
        let m = parse_mentions(Some("<p>Hello world</p>"));
        assert!(m.mentioned_people.is_empty());
        assert!(m.mentioned_groups.is_empty());
    }
}
