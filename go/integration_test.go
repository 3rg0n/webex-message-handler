package webexmessagehandler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	webex "github.com/3rg0n/webex-message-handler/go"
)

// Integration test: Send a message via REST API and receive it via Mercury WebSocket.
//
// This test verifies the entire pipeline:
// 1. Device registration (WDM)
// 2. Mercury WebSocket connection
// 3. KMS initialization (ECDH handshake)
// 4. Message send (REST API)
// 5. Message receive (Mercury)
// 6. Message decryption (KMS)
//
// Run with: WEBEX_BOT_TOKEN=receiver_token WEBEX_BOT_TOKEN_TEST=sender_token go test -v -run TestIntegration

const timeoutSeconds = 30

type webexPerson struct {
	ID          string   `json:"id"`
	Emails      []string `json:"emails"`
	DisplayName string   `json:"displayName"`
}

type webexMessage struct {
	ID string `json:"id"`
}

func TestIntegrationSendAndReceive(t *testing.T) {
	receiverToken := os.Getenv("WEBEX_BOT_TOKEN")
	if receiverToken == "" {
		t.Skip("WEBEX_BOT_TOKEN environment variable not set (bot that receives messages)")
	}

	senderToken := os.Getenv("WEBEX_BOT_TOKEN_TEST")
	if senderToken == "" {
		t.Skip("WEBEX_BOT_TOKEN_TEST environment variable not set (bot that sends test message)")
	}

	fmt.Println("\n🚀 Starting integration test...")

	// Create handler with receiver bot
	handler, err := webex.New(webex.Config{
		Token: receiverToken,
	})
	if err != nil {
		t.Fatalf("Failed to create handler: %v", err)
	}

	// Unique test message
	testMessage := fmt.Sprintf("Integration test %d", time.Now().UnixMilli())
	receivedChan := make(chan string, 1)

	handler.OnMessageCreated(func(msg webex.DecryptedMessage) {
		fmt.Printf("📨 Received message: \"%s\" from %s\n", msg.Text, msg.PersonEmail)
		if msg.Text == testMessage {
			select {
			case receivedChan <- msg.Text:
			default:
			}
		}
	})

	handler.OnConnected(func() {
		fmt.Println("✅ Connected to Mercury")
	})

	handler.OnError(func(err error) {
		fmt.Printf("❌ Handler error: %v\n", err)
	})

	ctx := context.Background()

	// Step 1: Connect to Mercury
	fmt.Println("1️⃣  Connecting to Mercury...")
	if err := handler.Connect(ctx); err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer handler.Disconnect(ctx)

	// Step 2: Get both bot identities
	fmt.Println("2️⃣  Fetching bot identities...")
	receiver, err := getWhoAmI(receiverToken)
	if err != nil {
		t.Fatalf("Failed to get receiver bot identity: %v", err)
	}
	sender, err := getWhoAmI(senderToken)
	if err != nil {
		t.Fatalf("Failed to get sender bot identity: %v", err)
	}
	fmt.Printf("   Receiver: %s (%s)\n", receiver.DisplayName, receiver.Emails[0])
	fmt.Printf("   Sender: %s (%s)\n", sender.DisplayName, sender.Emails[0])

	// Step 3: Send message FROM sender bot TO receiver bot
	fmt.Printf("3️⃣  Sending test message: \"%s\"\n", testMessage)
	msgID, err := sendMessage(senderToken, receiver.Emails[0], testMessage)
	if err != nil {
		t.Fatalf("Failed to send message: %v", err)
	}
	fmt.Printf("   Message sent (ID: %s)\n", msgID)

	// Step 4: Wait for message to arrive via Mercury
	fmt.Println("4️⃣  Waiting for message to arrive via Mercury...")
	select {
	case receivedText := <-receivedChan:
		// Step 5: Verify result
		fmt.Println("\n📊 Test Results:")
		fmt.Println("✅ PASSED - Message received and decrypted successfully")
		fmt.Printf("   Expected: \"%s\"\n", testMessage)
		fmt.Printf("   Received: \"%s\"\n", receivedText)
		if receivedText != testMessage {
			t.Errorf("Message mismatch: expected %q, got %q", testMessage, receivedText)
		}
	case <-time.After(timeoutSeconds * time.Second):
		fmt.Println("\n📊 Test Results:")
		fmt.Println("❌ FAILED - Message not received within timeout")
		t.Fatal("Integration test failed: message not received")
	}

	// Cleanup
	fmt.Println("\n🧹 Cleaning up...")
	handler.Disconnect(ctx)
	fmt.Println("✅ Disconnected")
}

func getWhoAmI(token string) (*webexPerson, error) {
	req, err := http.NewRequest("GET", "https://webexapis.com/v1/people/me", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}

	var person webexPerson
	if err := json.NewDecoder(resp.Body).Decode(&person); err != nil {
		return nil, err
	}

	return &person, nil
}

func sendMessage(token, toEmail, text string) (string, error) {
	body := map[string]string{
		"toPersonEmail": toEmail,
		"text":          text,
	}
	bodyJSON, _ := json.Marshal(body)

	req, err := http.NewRequest("POST", "https://webexapis.com/v1/messages", strings.NewReader(string(bodyJSON)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}

	var msg webexMessage
	if err := json.NewDecoder(resp.Body).Decode(&msg); err != nil {
		return "", err
	}

	return msg.ID, nil
}
