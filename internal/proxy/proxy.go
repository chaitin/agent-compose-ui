package proxy

import (
	"context"
	"crypto/tls"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/http2"
)

func NewBackendProxy(backend *url.URL) http.Handler {
	return newBackendProxy(backend, defaultTransport(), nil)
}

func NewTokenBackendProxy(backend *url.URL) http.Handler {
	return newBackendProxy(backend, tokenTransport(backend), func(req *http.Request) {
		for _, name := range []string{
			"Authorization", "Cookie", "Proxy-Authorization", "Forwarded",
			"X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP",
		} {
			req.Header.Del(name)
		}
		// A nil X-Forwarded-For value prevents ReverseProxy from synthesizing one.
		req.Header["X-Forwarded-For"] = nil
	})
}

func newBackendProxy(backend *url.URL, transport http.RoundTripper, amend func(*http.Request)) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(backend)
	// Connect server streams use application/connect+proto or
	// application/connect+json rather than text/event-stream. ReverseProxy's
	// default streaming heuristic does not recognize those content types and
	// can buffer small RunAgentStream messages until the request completes.
	// Flush every write so STARTED/OUTPUT events reach the browser immediately.
	proxy.FlushInterval = -1
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalHost := req.Host
		originalDirector(req)
		if isSensitiveResponsePath(req.URL.Path) {
			// The response body must remain uncompressed so sensitive event payloads
			// can be removed before the response leaves the UI server.
			req.Header.Set("Accept-Encoding", "identity")
		}
		if req.Header.Get("X-Forwarded-Host") == "" {
			req.Header.Set("X-Forwarded-Host", originalHost)
		}
		if amend != nil {
			amend(req)
		}
	}
	proxy.Transport = transport
	proxy.ModifyResponse = redactSensitiveResponse
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		slog.Error("proxy request failed", "path", r.URL.Path, "error", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"后端服务请求失败"}` + "\n"))
	}
	return proxy
}

func defaultTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          256,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
}

func tokenTransport(target *url.URL) http.RoundTripper {
	ordinary := defaultTransport()
	if !strings.EqualFold(target.Scheme, "http") {
		return ordinary
	}
	h2cTransport := &http2.Transport{
		AllowHTTP: true,
		DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
			return (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
		},
		ReadIdleTimeout: 30 * time.Second,
		PingTimeout:     10 * time.Second,
	}
	return attachRoundTripper{ordinary: ordinary, attach: h2cTransport}
}

type attachRoundTripper struct {
	ordinary http.RoundTripper
	attach   http.RoundTripper
}

func (t attachRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Path == "/agentcompose.v2.RunService/AttachAgentRun" || req.URL.Path == "/agentcompose.v2.ExecService/AttachExec" {
		return t.attach.RoundTrip(req)
	}
	return t.ordinary.RoundTrip(req)
}
