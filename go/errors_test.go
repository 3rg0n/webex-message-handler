package webexmessagehandler

import (
	"errors"
	"fmt"
	"testing"
)

func TestAuthError(t *testing.T) {
	err := NewAuthError("token expired")
	if err.Code != "AUTH_ERROR" {
		t.Errorf("expected AUTH_ERROR, got %q", err.Code)
	}
	if err.Error() != "token expired" {
		t.Errorf("expected 'token expired', got %q", err.Error())
	}
}

func TestDeviceRegistrationError(t *testing.T) {
	err := NewDeviceRegistrationError("registration failed", 500)
	if err.Code != "DEVICE_REGISTRATION_ERROR" {
		t.Errorf("expected DEVICE_REGISTRATION_ERROR, got %q", err.Code)
	}
	if err.StatusCode != 500 {
		t.Errorf("expected 500, got %d", err.StatusCode)
	}
	if err.Error() != "registration failed" {
		t.Errorf("expected 'registration failed', got %q", err.Error())
	}
}

func TestMercuryConnectionError(t *testing.T) {
	err := NewMercuryConnectionError("ws failed", 4401)
	if err.Code != "MERCURY_CONNECTION_ERROR" {
		t.Errorf("expected MERCURY_CONNECTION_ERROR, got %q", err.Code)
	}
	if err.CloseCode != 4401 {
		t.Errorf("expected 4401, got %d", err.CloseCode)
	}
}

func TestKmsError(t *testing.T) {
	err := NewKmsError("handshake failed")
	if err.Code != "KMS_ERROR" {
		t.Errorf("expected KMS_ERROR, got %q", err.Code)
	}
	if err.Error() != "handshake failed" {
		t.Errorf("expected 'handshake failed', got %q", err.Error())
	}
}

func TestKmsErrorWithCause(t *testing.T) {
	cause := fmt.Errorf("network error")
	err := NewKmsErrorWithCause("request failed", cause)
	if err.Code != "KMS_ERROR" {
		t.Errorf("expected KMS_ERROR, got %q", err.Code)
	}
	if !errors.Is(err, cause) {
		t.Error("expected Unwrap to return cause")
	}
	expected := "request failed: network error"
	if err.Error() != expected {
		t.Errorf("expected %q, got %q", expected, err.Error())
	}
}

func TestDecryptionError(t *testing.T) {
	err := NewDecryptionError("decrypt failed")
	if err.Code != "DECRYPTION_ERROR" {
		t.Errorf("expected DECRYPTION_ERROR, got %q", err.Code)
	}
}

func TestDecryptionErrorWithCause(t *testing.T) {
	cause := fmt.Errorf("bad key")
	err := NewDecryptionErrorWithCause("unwrap failed", cause)
	if !errors.Is(err, cause) {
		t.Error("expected Unwrap to return cause")
	}
}

func TestWebexErrorUnwrapNil(t *testing.T) {
	err := &WebexError{Message: "test", Code: "TEST"}
	if err.Unwrap() != nil {
		t.Error("expected nil Unwrap when no cause")
	}
}

func TestErrorsAs(t *testing.T) {
	err := NewAuthError("unauthorized")
	var authErr *AuthError
	if !errors.As(err, &authErr) {
		t.Error("expected errors.As to match *AuthError")
	}

	var deviceErr *DeviceRegistrationError
	if errors.As(err, &deviceErr) {
		t.Error("expected errors.As NOT to match *DeviceRegistrationError for an AuthError")
	}
}
