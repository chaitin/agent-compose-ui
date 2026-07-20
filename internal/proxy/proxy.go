package proxy

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
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
	return newReverseProxy(target, nil)
}

func NewScripts(target *url.URL, scriptToken string) http.Handler {
	return newReverseProxy(target, func(req *http.Request) {
		req.Header.Del(scriptTokenHeader)
		req.Header.Set(scriptTokenHeader, scriptToken)
	})
}

func newReverseProxy(target *url.URL, amend func(*http.Request)) http.Handler {
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
	reverseProxy.Transport = transport
	reverseProxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "bad gateway"})
	}
	return reverseProxy
}
