package webexmessagehandler

import "log/slog"

// Logger defines the logging interface used by the handler.
// Compatible with *slog.Logger via the SlogAdapter.
type Logger interface {
	Debug(msg string, args ...any)
	Info(msg string, args ...any)
	Warn(msg string, args ...any)
	Error(msg string, args ...any)
}

// noopLogger is a silent logger — all methods are no-ops.
type noopLogger struct{}

func (noopLogger) Debug(string, ...any) {}
func (noopLogger) Info(string, ...any)  {}
func (noopLogger) Warn(string, ...any)  {}
func (noopLogger) Error(string, ...any) {}

// NoopLogger returns a silent logger.
func NoopLogger() Logger { return noopLogger{} }

// SlogLogger wraps a *slog.Logger to implement the Logger interface.
type SlogLogger struct {
	L *slog.Logger
}

func (s *SlogLogger) Debug(msg string, args ...any) { s.L.Debug(msg, args...) }
func (s *SlogLogger) Info(msg string, args ...any)  { s.L.Info(msg, args...) }
func (s *SlogLogger) Warn(msg string, args ...any)  { s.L.Warn(msg, args...) }
func (s *SlogLogger) Error(msg string, args ...any) { s.L.Error(msg, args...) }

// NewSlogLogger creates a Logger from a *slog.Logger.
func NewSlogLogger(l *slog.Logger) Logger {
	return &SlogLogger{L: l}
}
