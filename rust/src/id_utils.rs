//! Convert between Mercury activity UUIDs and Webex REST API IDs.

use base64::{Engine as _, engine::general_purpose::STANDARD};

/// Convert a Mercury activity UUID to a Webex REST API ID.
///
/// Mercury uses raw UUIDs; the REST API uses base64-encoded
/// `ciscospark://us/{type}/{uuid}` URIs.
///
/// `resource_type` should be `"MESSAGE"`, `"PEOPLE"`, or `"ROOM"`.
pub fn to_rest_id(uuid: &str, resource_type: &str) -> String {
    let uri = format!("ciscospark://us/{}/{}", resource_type, uuid);
    STANDARD.encode(uri.as_bytes())
}

/// Convert a Webex REST API ID back to a raw UUID.
pub fn from_rest_id(rest_id: &str) -> Result<String, String> {
    let decoded = STANDARD
        .decode(rest_id)
        .map_err(|e| format!("invalid base64 in REST ID: {e}"))?;
    let s = String::from_utf8(decoded)
        .map_err(|e| format!("invalid UTF-8 in REST ID: {e}"))?;
    let last_slash = s.rfind('/').ok_or_else(|| format!("invalid REST ID format: {rest_id}"))?;
    Ok(s[last_slash + 1..].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_roundtrip() {
        let uuid = "abc-123-def";
        let rest = to_rest_id(uuid, "MESSAGE");
        let back = from_rest_id(&rest).unwrap();
        assert_eq!(back, uuid);
    }

    #[test]
    fn test_invalid_base64() {
        assert!(from_rest_id("!!!invalid!!!").is_err());
    }
}
