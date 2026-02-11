package webexmessagehandler

import (
	"context"
	"io"
	"net/http"
	"strings"
)

// createTestHTTPAdapter creates an HTTP adapter for testing that uses an http.Client.
func createTestHTTPAdapter(client *http.Client) fetchDoFn {
	if client == nil {
		client = http.DefaultClient
	}
	return func(ctx context.Context, req FetchRequest) (*FetchResponse, error) {
		var body io.Reader
		if req.Body != "" {
			body = strings.NewReader(req.Body)
		}

		httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, body)
		if err != nil {
			return nil, err
		}
		for k, v := range req.Headers {
			httpReq.Header.Set(k, v)
		}

		resp, err := client.Do(httpReq)
		if err != nil {
			return nil, err
		}

		return &FetchResponse{
			Status: resp.StatusCode,
			OK:     resp.StatusCode >= 200 && resp.StatusCode < 300,
			Body:   resp.Body,
		}, nil
	}
}
