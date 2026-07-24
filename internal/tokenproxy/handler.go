package tokenproxy

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"agent-compose-ui/internal/apitoken"
)

type authenticator interface {
	Authenticate(context.Context, string) (apitoken.Identity, error)
}

type Handler struct {
	store  authenticator
	proxy  http.Handler
	logger *slog.Logger
}

func New(store authenticator, proxy http.Handler, logger *slog.Logger) *Handler {
	return &Handler{store: store, proxy: proxy, logger: logger}
}

func UnavailableHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeConnectError(w, http.StatusServiceUnavailable, "unavailable", "token api is not enabled")
	})
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	raw, ok := bearerToken(r.Header.Values("Authorization"))
	if !ok {
		writeUnauthorized(w)
		h.log("", "", r, "deny", http.StatusUnauthorized, started)
		return
	}
	identity, err := h.store.Authenticate(r.Context(), raw)
	if err != nil {
		if errors.Is(err, apitoken.ErrInvalidToken) {
			writeUnauthorized(w)
			h.log("", "", r, "deny", http.StatusUnauthorized, started)
			return
		}
		writeConnectError(w, http.StatusServiceUnavailable, "unavailable", "token service unavailable")
		h.log("", "", r, "error", http.StatusServiceUnavailable, started)
		return
	}
	if !authorized(identity.Role, r) {
		writeConnectError(w, http.StatusForbidden, "permission_denied", "permission denied")
		h.log(identity.ID, identity.Role, r, "deny", http.StatusForbidden, started)
		return
	}
	sanitizeHeaders(r.Header)
	tracked := &statusWriter{ResponseWriter: w, status: http.StatusOK}
	h.proxy.ServeHTTP(tracked, r)
	h.log(identity.ID, identity.Role, r, "allow", tracked.status, started)
}

func bearerToken(values []string) (string, bool) {
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return "", false
	}
	token := strings.TrimPrefix(values[0], "Bearer ")
	return token, token != "" && strings.TrimSpace(token) == token && !strings.ContainsAny(token, " \t\r\n")
}

func sanitizeHeaders(header http.Header) {
	for _, name := range []string{
		"Authorization", "Cookie", "Proxy-Authorization", "Forwarded", "X-Forwarded-For",
		"X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP",
	} {
		header.Del(name)
	}
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="agent-compose-token-api"`)
	writeConnectError(w, http.StatusUnauthorized, "unauthenticated", "authentication required")
}

func writeConnectError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "message": message})
}

func (h *Handler) log(id string, role apitoken.Role, r *http.Request, decision string, status int, started time.Time) {
	if h.logger == nil {
		return
	}
	h.logger.InfoContext(r.Context(), "token api request",
		"token_id", id,
		"role", role,
		"method", r.Method,
		"path", r.URL.Path,
		"decision", decision,
		"status", status,
		"duration", time.Since(started),
	)
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.status = status
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(body []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *statusWriter) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}
