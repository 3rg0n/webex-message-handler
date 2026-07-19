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

// newNativeWebSocketWithHeaders dials the WebSocket with optional extra HTTP
// headers on the upgrade request. Mercury binds the connection's live activity
// subscription to the identity on the upgrade request's Authorization header,
// so the token must be presented there (in addition to the in-band auth frame)
// for conversation.activity events to be routed to the socket.
func newNativeWebSocketWithHeaders(ctx context.Context, url string, httpClient *http.Client, header http.Header) (WebSocket, error) {
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPClient: httpClient,
		HTTPHeader: header,
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
