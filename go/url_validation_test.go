package webexmessagehandler

import "testing"

func TestValidateWebexURL_ValidHTTPS(t *testing.T) {
	tests := []string{
		"https://webex.com/api/v1",
		"https://wdm-a.wbx2.com/wdm/api",
		"https://api.ciscospark.com/v1",
		"https://encryption-a.wbx2.com/encryption/api/v1",
	}
	for _, url := range tests {
		if err := validateWebexURL(url, "https"); err != nil {
			t.Errorf("expected %q to be valid, got: %v", url, err)
		}
	}
}

func TestValidateWebexURL_ValidWSS(t *testing.T) {
	if err := validateWebexURL("wss://mercury.webex.com/socket", "wss"); err != nil {
		t.Errorf("expected valid WSS URL, got: %v", err)
	}
}

func TestValidateWebexURL_ValidKMS(t *testing.T) {
	tests := []string{
		"kms://ciscospark.com/keys",
		"kms://ciscospark.com/keys/key/123",
		"kms://encryption.ciscospark.com/keys",
	}
	for _, url := range tests {
		if err := validateWebexURL(url, "kms"); err != nil {
			t.Errorf("expected %q to be valid kms URL, got: %v", url, err)
		}
	}
}

func TestValidateWebexURL_RejectsWrongScheme(t *testing.T) {
	if err := validateWebexURL("http://webex.com/api", "https"); err == nil {
		t.Error("expected error for http:// when https required")
	}
	if err := validateWebexURL("https://ciscospark.com/keys", "kms"); err == nil {
		t.Error("expected error for https:// when kms required")
	}
	if err := validateWebexURL("kms://ciscospark.com/keys", "https"); err == nil {
		t.Error("expected error for kms:// when https required")
	}
}

func TestValidateWebexURL_RejectsInvalidDomain(t *testing.T) {
	if err := validateWebexURL("https://evil.com/api", "https"); err == nil {
		t.Error("expected error for non-Webex domain")
	}
	if err := validateWebexURL("kms://evil.com/keys", "kms"); err == nil {
		t.Error("expected error for non-Webex domain with kms scheme")
	}
}

func TestValidateWebexURL_RejectsInvalidURL(t *testing.T) {
	if err := validateWebexURL("://missing-scheme", "https"); err == nil {
		t.Error("expected error for missing scheme")
	}
}
