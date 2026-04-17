package webexmessagehandler

import "fmt"

// WebexError is the base error type for all webex-message-handler errors.
type WebexError struct {
	Message string
	Code    string
	Cause   error
}

func (e *WebexError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Cause)
	}
	return e.Message
}

func (e *WebexError) Unwrap() error { return e.Cause }

// AuthError indicates the token is invalid, expired, or unauthorized.
type AuthError struct {
	WebexError
}

func NewAuthError(message string) *AuthError {
	return &AuthError{WebexError{Message: message, Code: "AUTH_ERROR"}}
}

// DeviceRegistrationError indicates WDM device operations failed.
type DeviceRegistrationError struct {
	WebexError
	StatusCode int
}

func NewDeviceRegistrationError(message string, statusCode int) *DeviceRegistrationError {
	return &DeviceRegistrationError{
		WebexError: WebexError{Message: message, Code: "DEVICE_REGISTRATION_ERROR"},
		StatusCode: statusCode,
	}
}

// MercuryConnectionError indicates WebSocket connection failure.
type MercuryConnectionError struct {
	WebexError
	CloseCode int
}

func NewMercuryConnectionError(message string, closeCode int) *MercuryConnectionError {
	return &MercuryConnectionError{
		WebexError: WebexError{Message: message, Code: "MERCURY_CONNECTION_ERROR"},
		CloseCode:  closeCode,
	}
}

// KmsError indicates KMS key exchange or key retrieval failure.
type KmsError struct {
	WebexError
}

func NewKmsError(message string) *KmsError {
	return &KmsError{WebexError{Message: message, Code: "KMS_ERROR"}}
}

func NewKmsErrorWithCause(message string, cause error) *KmsError {
	return &KmsError{WebexError{Message: message, Code: "KMS_ERROR", Cause: cause}}
}

// DecryptionError indicates message decryption failure.
type DecryptionError struct {
	WebexError
}

func NewDecryptionError(message string) *DecryptionError {
	return &DecryptionError{WebexError{Message: message, Code: "DECRYPTION_ERROR"}}
}

func NewDecryptionErrorWithCause(message string, cause error) *DecryptionError {
	return &DecryptionError{WebexError{Message: message, Code: "DECRYPTION_ERROR", Cause: cause}}
}
