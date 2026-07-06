package auth

import (
	"net/http"
	"net/url"
	"strings"
)

func isPublicAuthPath(path string) bool {
	if strings.HasPrefix(path, "/api/webhooks/") {
		return true
	}
	return path == "/login" || path == "/api/auth/status" || path == "/api/auth/login" || path == "/api/auth/logout" ||
		path == "/oauth/authorize" || path == "/oauth/callback"
}

func isRuntimeLLMFacadeRequest(r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	path := strings.TrimRight(r.URL.Path, "/")
	return strings.HasPrefix(path, "/api/runtime/sessions/") &&
		(strings.HasSuffix(path, "/llm/openai/v1/responses") ||
			strings.HasSuffix(path, "/llm/openai/v1/chat/completions") ||
			strings.HasSuffix(path, "/llm/anthropic/v1/messages"))
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
