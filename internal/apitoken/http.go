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
)

const (
	maxCreateBody       = 4 << 10
	defaultValidityDays = 90
)

var allowedValidityDays = map[int]struct{}{1: {}, 7: {}, 30: {}, 90: {}, 365: {}}

type tokenStore interface {
	Create(context.Context, string, Role, time.Duration) (Created, error)
	List(context.Context) ([]Metadata, error)
	Revoke(context.Context, string) error
}

type HTTPHandler struct {
	store tokenStore
	mux   *http.ServeMux
}

func NewHTTPHandler(store tokenStore) *HTTPHandler {
	h := &HTTPHandler{store: store, mux: http.NewServeMux()}
	h.mux.HandleFunc("GET /ui-api/v1/tokens", h.list)
	h.mux.HandleFunc("POST /ui-api/v1/tokens", h.create)
	h.mux.HandleFunc("DELETE /ui-api/v1/tokens/{id}", h.revoke)
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
	items, err := h.store.List(r.Context())
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
	created, err := h.store.Create(r.Context(), input.Name, input.Role, time.Duration(input.ExpiresInDays)*24*time.Hour)
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
	if err := h.store.Revoke(r.Context(), id); err != nil {
		writeStoreError(w, err)
		return
	}
	noStore(w)
	w.WriteHeader(http.StatusNoContent)
}

func validPublicID(value string) bool {
	_, err := parseToken(tokenPrefix + value + "_" + strings.Repeat("0", secretHexLength))
	return err == nil
}

func sameOrigin(r *http.Request) bool {
	if strings.EqualFold(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")), "cross-site") {
		return false
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
