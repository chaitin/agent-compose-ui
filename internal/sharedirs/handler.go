package sharedirs

import (
	"encoding/json"
	"fmt"
	"net/http"
)

type handler struct{ entries []Entry }

func NewHandler(entries []Entry) (http.Handler, error) {
	if err := validateCatalog(entries); err != nil {
		return nil, fmt.Errorf("invalid shared directory catalog: %w", err)
	}
	return &handler{entries: append([]Entry(nil), entries...)}, nil
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "method not allowed"})
		return
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "query parameters are not allowed"})
		return
	}
	entries := h.entries
	if entries == nil {
		entries = []Entry{}
	}
	_ = json.NewEncoder(w).Encode(struct {
		Entries []Entry `json:"entries"`
	}{Entries: entries})
}
