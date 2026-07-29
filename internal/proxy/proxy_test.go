package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"
)

func TestBackendProxyFlushesConnectStreamBeforeCompletion(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/connect+json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("first"))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		<-release
		_, _ = w.Write([]byte("second"))
	}))
	defer backend.Close()

	backendURL, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatalf("parse backend URL: %v", err)
	}
	frontend := httptest.NewServer(NewBackendProxy(backendURL))
	defer frontend.Close()

	type response struct {
		body string
		err  error
	}
	first := make(chan response, 1)
	go func() {
		resp, requestErr := http.Get(frontend.URL) //nolint:gosec // local httptest server
		if requestErr != nil {
			first <- response{err: requestErr}
			return
		}
		defer func() { _ = resp.Body.Close() }()
		buf := make([]byte, len("first"))
		_, readErr := io.ReadFull(resp.Body, buf)
		first <- response{body: string(buf), err: readErr}
	}()

	select {
	case got := <-first:
		if got.err != nil {
			t.Fatalf("read first streamed chunk: %v", got.err)
		}
		if got.body != "first" {
			t.Fatalf("first streamed chunk = %q, want %q", got.body, "first")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first Connect stream chunk was buffered until backend completion")
	}
	unblock()
}
