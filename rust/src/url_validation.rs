//! URL validation for external API responses.

const ALLOWED_DOMAIN_SUFFIXES: &[&str] = &[".webex.com", ".wbx2.com", ".ciscospark.com"];

/// Validates that a URL is HTTPS and belongs to a recognized Webex domain.
///
/// # Arguments
/// * `raw_url` - The URL string to validate
/// * `required_scheme` - The required scheme (typically "https" or "wss")
///
/// # Returns
/// * `Ok(())` if valid
/// * `Err(String)` with validation error message if invalid
pub fn validate_webex_url(raw_url: &str, required_scheme: &str) -> Result<(), String> {
    // Extract scheme
    let scheme_end = raw_url.find("://").ok_or_else(|| "URL missing scheme".to_string())?;
    let scheme = &raw_url[..scheme_end];

    if scheme != required_scheme {
        return Err(format!(
            "URL scheme must be {required_scheme}, got {scheme}"
        ));
    }

    // Extract host portion
    let after_scheme = &raw_url[scheme_end + 3..];
    let host = after_scheme.split('/').next().unwrap_or("");
    let host_lower = host.to_lowercase();

    // Remove port if present
    let host_without_port = host_lower.split(':').next().unwrap_or(&host_lower);

    // Check if host ends with an allowed domain
    // Allow both *.webex.com format and webex.com format (bare domain)
    let is_allowed = ALLOWED_DOMAIN_SUFFIXES
        .iter()
        .any(|suffix| host_without_port.ends_with(suffix) || host_without_port == &suffix[1..]);

    if !is_allowed {
        return Err(format!(
            "URL host {host_without_port} is not a recognized Webex domain"
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_webex_com_https() {
        assert!(validate_webex_url("https://webex.com/api/v1", "https").is_ok());
    }

    #[test]
    fn test_valid_wbx2_com_https() {
        assert!(validate_webex_url("https://wdm-a.wbx2.com/wdm/api", "https").is_ok());
    }

    #[test]
    fn test_valid_ciscospark_com_https() {
        assert!(validate_webex_url("https://api.ciscospark.com/v1", "https").is_ok());
    }

    #[test]
    fn test_valid_wss_scheme() {
        assert!(validate_webex_url("wss://mercury.webex.com/socket", "wss").is_ok());
    }

    #[test]
    fn test_invalid_scheme() {
        let result = validate_webex_url("http://webex.com/api", "https");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("scheme must be https"));
    }

    #[test]
    fn test_invalid_domain() {
        let result = validate_webex_url("https://evil.com/api", "https");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not a recognized Webex domain"));
    }

    #[test]
    fn test_url_with_port() {
        assert!(validate_webex_url("https://webex.com:443/api", "https").is_ok());
    }

    #[test]
    fn test_missing_scheme() {
        let result = validate_webex_url("webex.com/api", "https");
        assert!(result.is_err());
    }

    #[test]
    fn test_valid_kms_scheme() {
        assert!(validate_webex_url("kms://ciscospark.com/keys", "kms").is_ok());
    }

    #[test]
    fn test_valid_kms_scheme_with_path() {
        assert!(validate_webex_url("kms://ciscospark.com/keys/key/123", "kms").is_ok());
    }

    #[test]
    fn test_valid_kms_scheme_subdomain() {
        assert!(validate_webex_url("kms://encryption.ciscospark.com/keys", "kms").is_ok());
    }

    #[test]
    fn test_rejects_https_when_kms_required() {
        let result = validate_webex_url("https://ciscospark.com/keys", "kms");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("scheme must be kms"));
    }

    #[test]
    fn test_rejects_kms_when_https_required() {
        let result = validate_webex_url("kms://ciscospark.com/keys", "https");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("scheme must be https"));
    }

    #[test]
    fn test_rejects_kms_invalid_domain() {
        let result = validate_webex_url("kms://evil.com/keys", "kms");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not a recognized Webex domain"));
    }
}
