package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

func TestTokenDaemonDoesNotForwardManagedHeaders(t *testing.T) {
	received := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	for name, value := range map[string]string{
		"Authorization": "Bearer secret", "Cookie": "session=secret", "Forwarded": "for=client",
		"Proxy-Authorization": "Basic secret",
		"X-Forwarded-For":     "client", "X-Forwarded-Host": "client.example", "X-Forwarded-Proto": "https", "X-Real-IP": "client",
	} {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	NewTokenBackendProxy(target).ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d", response.Code)
	}
	got := <-received
	for _, name := range []string{"Authorization", "Cookie", "Proxy-Authorization", "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP"} {
		if value := got.Get(name); value != "" {
			t.Errorf("%s = %q", name, value)
		}
	}
}

func TestTokenDaemonUsesH2COnlyForAttachProcedures(t *testing.T) {
	protocols := make(chan int, 3)
	upstream := httptest.NewUnstartedServer(h2c.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		protocols <- r.ProtoMajor
		w.WriteHeader(http.StatusNoContent)
	}), &http2.Server{}))
	upstream.EnableHTTP2 = true
	upstream.Start()
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewTokenBackendProxy(target)
	for _, test := range []struct {
		path      string
		wantProto int
	}{{"/agentcompose.v2.RunService/GetRun", 1}, {"/agentcompose.v2.RunService/RunAttach", 2}, {"/agentcompose.v2.ExecService/ExecAttach", 2}} {
		t.Run(test.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, test.path, nil))
			if response.Code != http.StatusNoContent || <-protocols != test.wantProto {
				t.Fatalf("status = %d, want upstream HTTP/%d", response.Code, test.wantProto)
			}
		})
	}
}
