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
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalHost := req.Host
		originalDirector(req)
		if req.Header.Get("X-Forwarded-Host") == "" {
			req.Header.Set("X-Forwarded-Host", originalHost)
		}
		if amend != nil {
			amend(req)
		}
	}
	proxy.Transport = transport
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		slog.Error("proxy request failed", "path", r.URL.Path, "error", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"failed to proxy daemon request"}` + "\n"))
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
	if req.URL.Path == "/agentcompose.v2.RunService/RunAttach" || req.URL.Path == "/agentcompose.v2.ExecService/ExecAttach" {
		return t.attach.RoundTrip(req)
	}
	return t.ordinary.RoundTrip(req)
}
