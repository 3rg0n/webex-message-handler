package webexmessagehandler

import (
	"log/slog"
	"os"
	"testing"
)

func TestNoopLogger(t *testing.T) {
	l := NoopLogger()
	// Should not panic
	l.Debug("test")
	l.Info("test")
	l.Warn("test")
	l.Error("test")
}

func TestSlogLogger(t *testing.T) {
	slogger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	l := NewSlogLogger(slogger)
	// Should not panic
	l.Debug("debug message")
	l.Info("info message")
	l.Warn("warn message")
	l.Error("error message")
}

func TestNoopLoggerImplementsInterface(t *testing.T) {
	var l Logger = NoopLogger()
	if l == nil {
		t.Fatal("expected non-nil logger")
	}
}

func TestSlogLoggerImplementsInterface(t *testing.T) {
	var l Logger = NewSlogLogger(slog.Default())
	if l == nil {
		t.Fatal("expected non-nil logger")
	}
}
