package proxy

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSchedulerResponsesRemovePayloadJSON(t *testing.T) {
	run := testProtoFields(map[uint64]string{1: "run-1", 14: `{"payload":{"body":{"token":"secret-run"}}}`, 15: "source-hash"})
	responseMessage := testProtoMessageField(1, run)
	filtered, err := removeSchedulerProtoPayloads(testGRPCFrame(responseMessage), schedulerResponseRuns)
	if err != nil {
		t.Fatalf("filter scheduler response: %v", err)
	}
	if strings.Contains(string(filtered), "secret-run") || !strings.Contains(string(filtered), "run-1") || !strings.Contains(string(filtered), "source-hash") {
		t.Fatalf("filtered scheduler response = %q", filtered)
	}

	jsonBody, err := removeSchedulerJSONPayloads(
		[]byte(`{"runs":[{"runId":"run-1","payloadJson":"secret-json","status":"SUCCEEDED"}],"nextCursor":"next"}`),
		schedulerResponseRuns,
	)
	if err != nil || strings.Contains(string(jsonBody), "secret-json") || !strings.Contains(string(jsonBody), "SUCCEEDED") {
		t.Fatalf("filtered scheduler JSON = %q, err=%v", jsonBody, err)
	}
}

func TestBatchSchedulerResponseRemovesNestedPayloadJSON(t *testing.T) {
	run := testProtoFields(map[uint64]string{1: "run-1", 14: "secret-batch"})
	result := append(testProtoFields(map[uint64]string{1: "sandbox-1"}), testProtoMessageField(2, run)...)
	filtered, err := removeSchedulerProtoPayloads(testGRPCFrame(testProtoMessageField(1, result)), schedulerResponseSandboxRuns)
	if err != nil || strings.Contains(string(filtered), "secret-batch") || !strings.Contains(string(filtered), "sandbox-1") {
		t.Fatalf("filtered batch response = %q, err=%v", filtered, err)
	}
}

func testProtoFields(fields map[uint64]string) []byte {
	var out bytes.Buffer
	for field := uint64(1); field <= 17; field++ {
		if value, ok := fields[field]; ok {
			writeProtoBytesField(&out, field<<3|2, []byte(value))
		}
	}
	return out.Bytes()
}

func testProtoMessageField(field uint64, message []byte) []byte {
	var out bytes.Buffer
	writeProtoBytesField(&out, field<<3|2, message)
	return out.Bytes()
}

func testGRPCFrame(message []byte) []byte {
	frame := make([]byte, 5, 5+len(message))
	binary.BigEndian.PutUint32(frame[1:], uint32(len(message)))
	return append(frame, message...)
}

func TestBackendProxyRemovesEventPayloads(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if encoding := r.Header.Get("Accept-Encoding"); encoding != "identity" {
			t.Errorf("event request Accept-Encoding = %q, want identity", encoding)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/events/event-1":
			_, _ = io.WriteString(w, `{"event":{"event_id":"event-1","topic":"webhook.test","payload":{"body":{"password":"secret-detail"}}}}`)
		case "/api/events":
			_, _ = io.WriteString(w, `{"items":[{"event_id":"event-1","payload":{"body":{"token":"secret-list"}}},{"event_id":"event-2"}],"next_after_sequence":2}`)
		default:
			_, _ = io.WriteString(w, `{"payload":{"body":{"token":"kept-for-non-document-route"}}}`)
		}
	}))
	defer backend.Close()
	backendURL, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatalf("parse backend URL: %v", err)
	}
	frontend := httptest.NewServer(NewBackendProxy(backendURL))
	defer frontend.Close()

	for _, path := range []string{"/api/events/event-1", "/api/events?topic=webhook.test"} {
		response, requestErr := http.Get(frontend.URL + path) //nolint:gosec // local httptest server
		if requestErr != nil {
			t.Fatalf("GET %s: %v", path, requestErr)
		}
		body, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if readErr != nil || response.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status=%d body=%q err=%v", path, response.StatusCode, body, readErr)
		}
		if strings.Contains(string(body), "secret-") || strings.Contains(string(body), `"payload"`) {
			t.Fatalf("GET %s leaked event payload: %s", path, body)
		}
		var decoded map[string]json.RawMessage
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Fatalf("GET %s returned invalid JSON: %v", path, err)
		}
	}
}

func TestBackendProxyKeepsEventSubresourceResponses(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"payload":{"marker":"subresource-response"}}`)
	}))
	defer backend.Close()
	backendURL, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatalf("parse backend URL: %v", err)
	}
	frontend := httptest.NewServer(NewBackendProxy(backendURL))
	defer frontend.Close()

	response, err := http.Get(frontend.URL + "/api/events/event-1/runs") //nolint:gosec // local httptest server
	if err != nil {
		t.Fatalf("GET event runs: %v", err)
	}
	body, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil || !strings.Contains(string(body), "subresource-response") {
		t.Fatalf("event runs body=%q err=%v", body, readErr)
	}
}

func TestBackendProxyFailsClosedForMalformedEventResponse(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"event":{"payload":{"body":"secret"}}`)
	}))
	defer backend.Close()
	backendURL, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatalf("parse backend URL: %v", err)
	}
	response := httptest.NewRecorder()
	NewBackendProxy(backendURL).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/events/event-1", nil))
	if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("malformed event response status=%d body=%q", response.Code, response.Body.String())
	}
}

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
