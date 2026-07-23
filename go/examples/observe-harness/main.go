// Command observe-harness is a standalone Webex Mercury observation tool. It
// removes the entire SignalStack application stack and exercises ONLY the
// webex-message-handler library, so inbound (Mercury) and outbound (REST)
// message flow can be observed directly.
//
// It:
//  1. Connects to Webex as the "bot"/observer account (wmh Mercury socket) with
//     verbose logging — every inbound DecryptedMessage/membership is printed.
//  2. Optionally creates a test room and adds a second user (the "poster").
//  3. Posts round-trip messages AS THE POSTER (a separate user token) via REST,
//     then reports whether the observer socket received each one — the core test
//     for the silent-delivery bug (#27).
//
// Tokens (env):
//
//	OBSERVER_TOKEN  — access token for the observing account (e.g. SignalStack).
//	                  Raw token; the lib adds the Mercury auth framing.
//	POSTER_TOKEN    — access token for a real user who will post messages
//	                  (so posts aren't self-filtered by the observer).
//	ROOM_ID         — optional: observe an existing room. If empty and
//	                  CREATE_ROOM=1, a new room is created with both parties.
//	POSTER_EMAIL    — email of the poster (added to a newly-created room).
//	CREATE_ROOM     — "1" to create a fresh test room.
//	ROUNDTRIPS      — number of test messages to post (default 3).
//	CARD_TEST       — "1" to also post an Adaptive Card with an Action.Submit
//	                  button and submit it, verifying the observer receives an
//	                  attachmentAction:created with decrypted Inputs.
//
// Set WMH_DEBUG_RAW_ACTIVITY=1 to log the structural shape of every Mercury
// conversation.activity (verb, object.objectType, key presence — never
// content), which reveals activities the handler does not match.
//
// Everything the harness prints is timestamped so inbound/outbound ordering and
// latency are visible.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	webex "github.com/3rg0n/webex-message-handler/go"
)

const webexAPIBase = "https://webexapis.com/v1"

func ts() string { return time.Now().UTC().Format("15:04:05.000") }

func logf(format string, a ...any) {
	fmt.Printf("%s  %s\n", ts(), fmt.Sprintf(format, a...))
}

// received tracks message texts the observer socket delivered, for round-trip
// matching. Guarded because the callback fires on library goroutines.
type received struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func (r *received) add(text string) {
	r.mu.Lock()
	r.seen[text] = time.Now()
	r.mu.Unlock()
}

func (r *received) has(text string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.seen[text]
	return ok
}

func main() {
	observerToken := os.Getenv("OBSERVER_TOKEN")
	posterToken := os.Getenv("POSTER_TOKEN")
	if observerToken == "" {
		fmt.Fprintln(os.Stderr, "OBSERVER_TOKEN is required")
		os.Exit(2)
	}

	roomID := os.Getenv("ROOM_ID")
	posterEmail := os.Getenv("POSTER_EMAIL")
	roundtrips := 3
	if v := os.Getenv("ROUNDTRIPS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			roundtrips = n
		}
	}

	rec := &received{seen: make(map[string]time.Time)}

	// Debug logger so the wmh internals (WS frames, auth, eventTypes) are visible.
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug}))

	handler, err := webex.New(webex.Config{
		Token:  observerToken,
		Logger: webex.NewSlogLogger(logger),
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "create handler: %v\n", err)
		os.Exit(1)
	}

	handler.OnMessageCreated(func(msg webex.DecryptedMessage) {
		logf("INBOUND message  room=%s from=%s text=%q", short(msg.RoomID), msg.PersonEmail, msg.Text)
		rec.add(msg.Text)
	})
	handler.OnMembershipCreated(func(m webex.MembershipActivity) {
		logf("INBOUND membership room=%s person=%s action=%s", short(m.RoomID), m.PersonID, m.Action)
	})
	handler.OnAttachmentActionCreated(func(a webex.AttachmentAction) {
		logf("INBOUND attachmentAction room=%s from=%s messageID=%s inputs=%#v",
			short(a.RoomID), a.PersonEmail, short(a.MessageID), a.Inputs)
		rec.add("attachmentAction")
	})
	handler.OnConnected(func() { logf("OBSERVER connected") })
	handler.OnDisconnected(func(reason string) { logf("OBSERVER disconnected: %s", reason) })
	handler.OnError(func(err error) { logf("OBSERVER error: %v", err) })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		logf("shutting down (unregistering device)…")
		_ = handler.Disconnect(context.Background())
		cancel()
	}()

	// Connect the observer socket in the background.
	go func() {
		if cErr := handler.Connect(ctx); cErr != nil {
			logf("OBSERVER connect failed: %v", cErr)
			cancel()
		}
	}()

	// Give the socket time to connect + finish the Mercury/KMS handshake.
	logf("waiting 8s for observer socket to become ready…")
	select {
	case <-ctx.Done():
		return
	case <-time.After(8 * time.Second):
	}
	st := handler.Status()
	logf("observer status: wsOpen=%v device=%v kms=%v", st.WebSocketOpen, st.DeviceRegistered, st.KmsInitialized)

	// Resolve/prepare the room to exercise.
	if roomID == "" && os.Getenv("CREATE_ROOM") == "1" {
		roomID, err = createRoom(ctx, posterToken, "observe-harness "+ts())
		if err != nil {
			logf("create room failed: %v", err)
			return
		}
		logf("created room %s", short(roomID))
		if posterEmail != "" {
			// Add the observer account too, so it can receive. The poster (creator)
			// is already a member. The observer is added via the poster's token.
			if aErr := addMembershipByObserver(ctx, observerToken, roomID, posterToken); aErr != nil {
				logf("note: could not auto-add observer to room: %v (add it manually)", aErr)
			}
		}
	}
	if roomID == "" {
		logf("no ROOM_ID and CREATE_ROOM!=1 — observing only; post a message manually to test")
	}

	// Round-trip: post as the poster, then check the observer received it.
	if roomID != "" && posterToken != "" {
		for i := 1; i <= roundtrips; i++ {
			text := fmt.Sprintf("observe-harness roundtrip %d @ %s", i, ts())
			if pErr := postMessage(ctx, posterToken, roomID, text); pErr != nil {
				logf("OUTBOUND post %d failed: %v", i, pErr)
				continue
			}
			logf("OUTBOUND posted %q — waiting up to 12s for observer to receive…", text)
			got := waitFor(ctx, func() bool { return rec.has(text) }, 12*time.Second)
			if got {
				logf("ROUNDTRIP %d: ✓ observer received the message", i)
			} else {
				logf("ROUNDTRIP %d: ✗ observer did NOT receive the message (silent delivery)", i)
			}
			time.Sleep(2 * time.Second)
		}
		logf("round-trips complete. Leaving the socket open for further manual observation; Ctrl-C to exit.")
	}

	// Card-action test: the observer posts an Adaptive Card with an
	// Action.Submit button, then submits the attachment action against it via
	// POST /v1/attachment/actions — the programmatic equivalent of clicking the
	// button. The observer socket should then receive an attachmentAction:created
	// with non-empty Inputs (card actions carry no self-message filter, so a
	// self-submit is delivered). With WMH_DEBUG_RAW_ACTIVITY=1 the structural
	// shape of every activity is logged, so a missed card action is visible even
	// if the matcher never fires.
	if os.Getenv("CARD_TEST") == "1" && roomID != "" {
		logf("CARD_TEST: posting an Adaptive Card with an Action.Submit button…")
		msgID, err := postCard(ctx, observerToken, roomID)
		if err != nil {
			logf("CARD_TEST: post card failed: %v", err)
		} else {
			logf("CARD_TEST: card posted messageID=%s — submitting attachment action…", short(msgID))
			time.Sleep(2 * time.Second)
			if sErr := submitAttachmentAction(ctx, observerToken, msgID); sErr != nil {
				logf("CARD_TEST: submit attachment action failed: %v", sErr)
			} else {
				logf("CARD_TEST: attachment action submitted — waiting up to 15s for observer to receive…")
				got := waitFor(ctx, func() bool { return rec.has("attachmentAction") }, 15*time.Second)
				if got {
					logf("CARD_TEST: ✓ observer received the attachmentAction")
				} else {
					logf("CARD_TEST: ✗ observer did NOT receive the attachmentAction (check WMH_DEBUG_RAW_ACTIVITY output above for the raw shape, if any)")
				}
			}
		}
		logf("CARD_TEST complete. Socket stays open for manual clicks; Ctrl-C to exit.")
	}

	<-ctx.Done()
}

func short(s string) string {
	if len(s) > 16 {
		return s[len(s)-16:]
	}
	return s
}

func waitFor(ctx context.Context, cond func() bool, d time.Duration) bool {
	deadline := time.After(d)
	tick := time.NewTicker(300 * time.Millisecond)
	defer tick.Stop()
	for {
		if cond() {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-deadline:
			return cond()
		case <-tick.C:
		}
	}
}

func createRoom(ctx context.Context, token, title string) (string, error) {
	body, _ := json.Marshal(map[string]string{"title": title})
	var out struct {
		ID string `json:"id"`
	}
	if err := doJSON(ctx, token, http.MethodPost, "/rooms", body, &out); err != nil {
		return "", err
	}
	return out.ID, nil
}

// addMembershipByObserver resolves the observer's own email via /people/me (using
// the observer token) and adds it to the room using the poster's token (the room
// creator/moderator).
func addMembershipByObserver(ctx context.Context, observerToken, roomID, posterToken string) error {
	var me struct {
		Emails []string `json:"emails"`
	}
	if err := doJSON(ctx, observerToken, http.MethodGet, "/people/me", nil, &me); err != nil {
		return fmt.Errorf("observer /people/me: %w", err)
	}
	if len(me.Emails) == 0 {
		return fmt.Errorf("observer has no email")
	}
	body, _ := json.Marshal(map[string]string{"roomId": roomID, "personEmail": me.Emails[0]})
	return doJSON(ctx, posterToken, http.MethodPost, "/memberships", body, nil)
}

func postMessage(ctx context.Context, token, roomID, text string) error {
	body, _ := json.Marshal(map[string]string{"roomId": roomID, "text": text})
	return doJSON(ctx, token, http.MethodPost, "/messages", body, nil)
}

// postCard posts an Adaptive Card with a single Action.Submit button whose data
// mirrors SignalStack's shape ({card_action, response_event_id, verdict}) and
// returns the created message ID.
func postCard(ctx context.Context, token, roomID string) (string, error) {
	card := map[string]interface{}{
		"$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
		"type":    "AdaptiveCard",
		"version": "1.2",
		"body": []interface{}{
			map[string]interface{}{"type": "TextBlock", "text": "observe-harness card test — click 👍", "wrap": true},
		},
		"actions": []interface{}{
			map[string]interface{}{
				"type":  "Action.Submit",
				"title": "👍",
				"data": map[string]interface{}{
					"card_action":       "answer_feedback",
					"response_event_id": "harness-" + ts(),
					"verdict":           "up",
				},
			},
		},
	}
	body, _ := json.Marshal(map[string]interface{}{
		"roomId":   roomID,
		"markdown": "Card test (fallback text for non-card clients).",
		"attachments": []interface{}{
			map[string]interface{}{
				"contentType": "application/vnd.microsoft.card.adaptive",
				"content":     card,
			},
		},
	})
	var out struct {
		ID string `json:"id"`
	}
	if err := doJSON(ctx, token, http.MethodPost, "/messages", body, &out); err != nil {
		return "", err
	}
	return out.ID, nil
}

// submitAttachmentAction submits a card Action.Submit against messageID — the
// programmatic equivalent of a user clicking the button — carrying the same
// inputs the card's data declared.
func submitAttachmentAction(ctx context.Context, token, messageID string) error {
	body, _ := json.Marshal(map[string]interface{}{
		"type":      "submit",
		"messageId": messageID,
		"inputs": map[string]interface{}{
			"card_action":       "answer_feedback",
			"response_event_id": "harness-submit-" + ts(),
			"verdict":           "up",
		},
	})
	return doJSON(ctx, token, http.MethodPost, "/attachment/actions", body, nil)
}

func doJSON(ctx context.Context, token, method, path string, body []byte, out any) error {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, webexAPIBase+path, r)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s %s -> HTTP %d: %s", method, path, resp.StatusCode, string(rb))
	}
	if out != nil {
		return json.Unmarshal(rb, out)
	}
	return nil
}
