package apitoken

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"agent-compose-ui/internal/audit"
)

const maxCreateBody = 4 << 10
const defaultValidityDays = 90

var allowedValidityDays = map[int]struct{}{1: {}, 7: {}, 30: {}, 90: {}, 365: {}}

type tokenStore interface {
	Create(context.Context, string, string, Role, time.Duration) (Created, error)
	List(context.Context, string) ([]Metadata, error)
	Revoke(context.Context, string, string) error
}

type HTTPHandler struct {
	store tokenStore
	mux   *http.ServeMux
}

func NewHTTPHandler(store tokenStore) *HTTPHandler {
	h := &HTTPHandler{store: store, mux: http.NewServeMux()}
	for _, prefix := range []string{"/api/ui/v1/tokens"} {
		h.mux.HandleFunc("GET "+prefix, h.list)
		h.mux.HandleFunc("POST "+prefix, h.create)
		h.mux.HandleFunc("DELETE "+prefix+"/{id}", h.revoke)
	}
	return h
}

func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mux.ServeHTTP(w, r)
}

func UnavailableHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "token management is not enabled"})
	})
}

func (h *HTTPHandler) list(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-site request rejected"})
		return
	}
	ownerID, ok := currentOwner(w, r)
	if !ok {
		return
	}
	items, err := h.store.List(r.Context(), ownerID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	noStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

type createRequest struct {
	Name          string `json:"name"`
	Role          Role   `json:"role"`
	ExpiresInDays int    `json:"expiresInDays"`
}

func (h *HTTPHandler) create(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-site request rejected"})
		return
	}
	if mediaType := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])); mediaType != "application/json" {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "content-type must be application/json"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxCreateBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input createRequest
	if err := decoder.Decode(&input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.ExpiresInDays == 0 {
		input.ExpiresInDays = defaultValidityDays
	}
	_, validityAllowed := allowedValidityDays[input.ExpiresInDays]
	if length := len([]rune(input.Name)); length < 1 || length > 64 || !input.Role.Valid() || !validityAllowed {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "name, role, or validity is invalid"})
		return
	}
	ownerID, ok := currentOwner(w, r)
	if !ok {
		return
	}
	created, err := h.store.Create(r.Context(), ownerID, input.Name, input.Role, time.Duration(input.ExpiresInDays)*24*time.Hour)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	noStore(w)
	writeJSON(w, http.StatusCreated, created)
}

func (h *HTTPHandler) revoke(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-site request rejected"})
		return
	}
	id := r.PathValue("id")
	if !validPublicID(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid token id"})
		return
	}
	ownerID, ok := currentOwner(w, r)
	if !ok {
		return
	}
	if err := h.store.Revoke(r.Context(), ownerID, id); err != nil {
		if errors.Is(err, ErrTokenNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "api token not found"})
			return
		}
		writeStoreError(w, err)
		return
	}
	noStore(w)
	w.WriteHeader(http.StatusNoContent)
}

func currentOwner(w http.ResponseWriter, r *http.Request) (string, bool) {
	principal := audit.PrincipalFromContext(r.Context())
	if principal.ID == "" || principal.ID == "anonymous" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
		return "", false
	}
	return principal.ID, true
}

func validPublicID(value string) bool {
	_, err := parseToken(tokenPrefix + value + "_" + strings.Repeat("0", secretHexLength))
	return err == nil
}

func sameOrigin(r *http.Request) bool {
	fetchSite := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")))
	if fetchSite == "cross-site" {
		return false
	}
	// Sec-Fetch-Site is a browser-controlled forbidden header. Prefer it when
	// present so a same-origin request remains valid after a trusted development
	// or deployment proxy rewrites Host.
	if fetchSite == "same-origin" {
		return true
	}
	rawOrigin := strings.TrimSpace(r.Header.Get("Origin"))
	if rawOrigin == "" {
		return true
	}
	origin, err := url.Parse(rawOrigin)
	if err != nil || origin.Host == "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	} else if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); forwarded != "" {
		scheme = strings.ToLower(strings.Split(forwarded, ",")[0])
	}
	return strings.EqualFold(origin.Scheme, scheme) && strings.EqualFold(origin.Host, r.Host)
}

func writeStoreError(w http.ResponseWriter, err error) {
	status := http.StatusServiceUnavailable
	if errors.Is(err, context.Canceled) {
		status = http.StatusRequestTimeout
	}
	writeJSON(w, status, map[string]string{"error": "token service unavailable"})
}

func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
