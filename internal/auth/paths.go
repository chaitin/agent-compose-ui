package auth

import (
	"net/http"
	"net/url"
	"strings"
)

func isPublicAuthRequest(r *http.Request) bool {
	switch r.URL.Path {
	case "/login":
		return r.Method == http.MethodGet || r.Method == http.MethodHead
	case "/api/auth/status", "/oauth/authorize", "/oauth/callback":
		return r.Method == http.MethodGet || r.Method == http.MethodHead
	case "/api/auth/login", "/api/auth/logout":
		return r.Method == http.MethodPost
	default:
		return r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/webhooks/")
	}
}

func isRuntimeLLMFacadeRequest(r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	for _, prefix := range []string{"/api/runtime/sandboxes/", "/api/runtime/sessions/"} {
		if !strings.HasPrefix(r.URL.Path, prefix) {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, prefix), "/")
		switch {
		case len(parts) == 5 && parts[0] != "" && parts[1] == "llm" && parts[2] == "openai" && parts[3] == "v1" && parts[4] == "responses":
			return true
		case len(parts) == 6 && parts[0] != "" && parts[1] == "llm" && parts[2] == "openai" && parts[3] == "v1" && parts[4] == "chat" && parts[5] == "completions":
			return true
		case len(parts) == 5 && parts[0] != "" && parts[1] == "llm" && parts[2] == "anthropic" && parts[3] == "v1" && parts[4] == "messages":
			return true
		}
	}
	return false
}

func acceptsHTML(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

func loginRedirectPath(r *http.Request) string {
	next := r.URL.RequestURI()
	if next == "" || isLoginPath(next) || strings.HasPrefix(next, "//") {
		return "/login"
	}
	return "/login?next=" + url.QueryEscape(next)
}

func sanitizeOAuthNext(next string) string {
	if next == "" || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || isLoginPath(next) {
		return "/"
	}
	return next
}

func isLoginPath(path string) bool {
	return path == "/login" || strings.HasPrefix(path, "/login?") || strings.HasPrefix(path, "/login#")
}
