package proxy

import (
	"bufio"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestDaemonProxyStreamsResponses(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, "first\n")
		flusher.Flush()
		<-release
		_, _ = io.WriteString(w, "second\n")
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	gateway := httptest.NewServer(NewDaemon(target))
	defer gateway.Close()
	defer close(release)

	response, err := http.Get(gateway.URL + "/agentcompose.v2.Test/Watch")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if line != "first\n" {
		t.Fatalf("first chunk = %q", line)
	}
}

func TestDaemonProxyPreservesRequest(t *testing.T) {
	received := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received <- r.Method + " " + r.URL.RequestURI() + " " + string(body) + " " + r.Header.Get("X-Forwarded-Host")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	request := httptest.NewRequest(http.MethodPost, "/agentcompose.v2.Test/Call?q=1", strings.NewReader("payload"))
	request.Host = "gateway.example"
	response := httptest.NewRecorder()
	NewDaemon(target).ServeHTTP(response, request)
	if got := <-received; got != "POST /agentcompose.v2.Test/Call?q=1 payload gateway.example" {
		t.Fatalf("received %q", got)
	}
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestScriptProxyReplacesClientToken(t *testing.T) {
	received := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Get("X-Script-Service-Token")
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	request := httptest.NewRequest(http.MethodGet, "/script-api/v1/health", nil)
	request.Header.Set("X-Script-Service-Token", "attacker")
	NewScripts(target, "server-token").ServeHTTP(httptest.NewRecorder(), request)
	if got := <-received; got != "server-token" {
		t.Fatalf("token = %q", got)
	}
}

func TestProxyFailureIsGeneric(t *testing.T) {
	target, _ := url.Parse("http://127.0.0.1:1")
	response := httptest.NewRecorder()
	NewDaemon(target).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/test", nil))
	if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "127.0.0.1") {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content type = %q", got)
	}
}
