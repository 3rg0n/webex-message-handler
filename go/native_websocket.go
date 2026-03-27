package webexmessagehandler

import (
	"context"
	"net/http"

	"github.com/coder/websocket"
)

// nativeWebSocket wraps github.com/coder/websocket to implement our WebSocket interface.
// For internal MercurySocket use, it exposes the raw connection.
type nativeWebSocket struct {
	Conn *websocket.Conn // Exported for internal use by MercurySocket
	ctx  context.Context
	done chan struct{}
}

func newNativeWebSocket(ctx context.Context, url string, httpClient *http.Client) (WebSocket, error) {
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPClient: httpClient,
	})
	if err != nil {
		return nil, err
	}

	done := make(chan struct{})

	ws := &nativeWebSocket{
		Conn: conn,
		ctx:  ctx,
		done: done,
	}

	return ws, nil
}

func (ws *nativeWebSocket) Send(data string) error {
	return ws.Conn.Write(ws.ctx, websocket.MessageText, []byte(data))
}

func (ws *nativeWebSocket) Receive() (string, error) {
	_, data, err := ws.Conn.Read(ws.ctx)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (ws *nativeWebSocket) Close() error {
	close(ws.done)
	return ws.Conn.Close(websocket.StatusNormalClosure, "")
}

func (ws *nativeWebSocket) Done() <-chan struct{} {
	return ws.done
}
