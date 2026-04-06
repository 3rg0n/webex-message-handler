package webexmessagehandler

import (
	"fmt"
	"net/url"
	"strings"
)

var allowedDomainSuffixes = []string{".webex.com", ".wbx2.com", ".ciscospark.com"}

// validateWebexURL validates that a URL uses the required scheme and points to a recognized Webex domain.
func validateWebexURL(rawURL string, requiredScheme string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if parsed.Scheme != requiredScheme {
		return fmt.Errorf("URL scheme must be %s, got %s", requiredScheme, parsed.Scheme)
	}
	host := strings.ToLower(parsed.Hostname())
	for _, suffix := range allowedDomainSuffixes {
		if strings.HasSuffix(host, suffix) {
			return nil
		}
	}
	return fmt.Errorf("URL host %s is not a recognized Webex domain", host)
}
