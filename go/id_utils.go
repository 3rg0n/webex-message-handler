package webexmessagehandler

import (
	"encoding/base64"
	"fmt"
	"strings"
)

// ToRestID converts a Mercury activity UUID to a Webex REST API ID.
//
// Mercury uses raw UUIDs; the REST API uses base64-encoded
// "ciscospark://us/{type}/{uuid}" URIs.
//
// resourceType should be "MESSAGE", "PEOPLE", or "ROOM".
func ToRestID(uuid string, resourceType string) string {
	uri := fmt.Sprintf("ciscospark://us/%s/%s", resourceType, uuid)
	return base64.StdEncoding.EncodeToString([]byte(uri))
}

// FromRestID converts a Webex REST API ID back to a raw UUID.
func FromRestID(restID string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(restID)
	if err != nil {
		return "", fmt.Errorf("invalid base64 in REST ID: %w", err)
	}
	s := string(decoded)
	lastSlash := strings.LastIndex(s, "/")
	if lastSlash == -1 {
		return "", fmt.Errorf("invalid REST ID format: %s", restID)
	}
	return s[lastSlash+1:], nil
}
