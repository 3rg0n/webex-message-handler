package webexmessagehandler

import "testing"

func TestToRestIDRoundtrip(t *testing.T) {
	uuid := "abc-123-def"
	restID := ToRestID(uuid, "MESSAGE")
	got, err := FromRestID(restID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != uuid {
		t.Errorf("expected %q, got %q", uuid, got)
	}
}

func TestToRestIDFormat(t *testing.T) {
	// Known encoding: "ciscospark://us/MESSAGE/test-uuid" in base64
	restID := ToRestID("test-uuid", "MESSAGE")
	if restID == "" {
		t.Error("expected non-empty REST ID")
	}
	// Verify it round-trips
	got, err := FromRestID(restID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "test-uuid" {
		t.Errorf("expected test-uuid, got %q", got)
	}
}

func TestToRestIDResourceTypes(t *testing.T) {
	for _, rt := range []string{"MESSAGE", "PEOPLE", "ROOM"} {
		restID := ToRestID("uuid-1", rt)
		got, err := FromRestID(restID)
		if err != nil {
			t.Fatalf("resource type %s: unexpected error: %v", rt, err)
		}
		if got != "uuid-1" {
			t.Errorf("resource type %s: expected uuid-1, got %q", rt, got)
		}
	}
}

func TestFromRestIDInvalidBase64(t *testing.T) {
	_, err := FromRestID("!!!invalid!!!")
	if err == nil {
		t.Error("expected error for invalid base64")
	}
}

func TestFromRestIDInvalidFormat(t *testing.T) {
	// Valid base64 but no slash in decoded string
	_, err := FromRestID("bm9zbGFzaA==") // "noslash"
	if err == nil {
		t.Error("expected error for invalid format")
	}
}
