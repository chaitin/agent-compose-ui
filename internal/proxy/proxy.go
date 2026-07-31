package proxy

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/http2"
)

const scriptTokenHeader = "X-Script-Service-Token"

var transport = &http.Transport{
	Proxy:                 http.ProxyFromEnvironment,
	DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
	ForceAttemptHTTP2:     true,
	MaxIdleConns:          100,
	MaxIdleConnsPerHost:   20,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ResponseHeaderTimeout: 60 * time.Second,
}

func NewDaemon(target *url.URL) http.Handler {
	return newReverseProxy(target, nil, transport)
}

func NewTokenDaemon(target *url.URL) http.Handler {
	return newReverseProxy(target, func(req *http.Request) {
		// A nil X-Forwarded-For value tells ReverseProxy not to synthesize one.
		req.Header["X-Forwarded-For"] = nil
		req.Header.Del("X-Forwarded-Host")
		req.Header.Del("X-Forwarded-Proto")
		req.Header.Del("X-Real-IP")
	}, tokenTransport(target))
}

func NewScripts(target *url.URL, scriptToken string) http.Handler {
	return newReverseProxy(target, func(req *http.Request) {
		req.Header.Del(scriptTokenHeader)
		req.Header.Set(scriptTokenHeader, scriptToken)
	}, transport)
}

func newReverseProxy(target *url.URL, amend func(*http.Request), roundTripper http.RoundTripper) http.Handler {
	reverseProxy := httputil.NewSingleHostReverseProxy(target)
	director := reverseProxy.Director
	reverseProxy.Director = func(req *http.Request) {
		forwardedHost := req.Host
		director(req)
		req.Header.Set("X-Forwarded-Host", forwardedHost)
		if amend != nil {
			amend(req)
		}
	}
	reverseProxy.Transport = roundTripper
	reverseProxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "bad gateway"})
	}
	return reverseProxy
}

func tokenTransport(target *url.URL) http.RoundTripper {
	if !strings.EqualFold(target.Scheme, "http") {
		return transport
	}
	h2cTransport := &http2.Transport{
		AllowHTTP: true,
		DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
			return (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
		},
		ReadIdleTimeout: 30 * time.Second,
		PingTimeout:     10 * time.Second,
	}
	return attachRoundTripper{ordinary: transport, attach: h2cTransport}
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
