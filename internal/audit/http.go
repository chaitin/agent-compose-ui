package audit

import (
	"encoding/csv"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type HTTPHandler struct {
	store *Store
	mux   *http.ServeMux
}

func NewHTTPHandler(store *Store) *HTTPHandler {
	h := &HTTPHandler{store: store, mux: http.NewServeMux()}
	h.mux.HandleFunc("GET /api/ui/v1/audit/events", h.list)
	h.mux.HandleFunc("GET /api/ui/v1/audit/export", h.export)
	return h
}
func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.mux.ServeHTTP(w, r) }

func UnavailableHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeAuditJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "audit storage is not enabled"})
	})
}

func (h *HTTPHandler) list(w http.ResponseWriter, r *http.Request) {
	page, err := h.store.Query(r.Context(), filterFromRequest(r, 100))
	if err != nil {
		writeAuditJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "audit storage unavailable"})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeAuditJSON(w, http.StatusOK, page)
}

func (h *HTTPHandler) export(w http.ResponseWriter, r *http.Request) {
	filter := filterFromRequest(r, 500)
	filter.Cursor = ""
	items := make([]Event, 0, 1000)
	truncated := false
	for len(items) < 10000 {
		page, err := h.store.Query(r.Context(), filter)
		if err != nil {
			writeAuditJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "audit storage unavailable"})
			return
		}
		items = append(items, page.Items...)
		if !page.HasMore {
			break
		}
		if len(items) >= 10000 {
			truncated = true
			break
		}
		filter.Cursor = page.NextCursor
	}
	if len(items) > 10000 {
		items = items[:10000]
		truncated = true
	}
	if strings.EqualFold(r.URL.Query().Get("format"), "csv") {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="audit-events.csv"`)
		w.Header().Set("X-Audit-Truncated", strconv.FormatBool(truncated))
		w.WriteHeader(http.StatusOK)
		writer := csv.NewWriter(w)
		_ = writer.Write([]string{"occurred_at", "actor", "source", "action", "resource_type", "resource_id", "outcome", "status", "duration_ms", "request_id", "remote_ip"})
		for _, item := range items {
			_ = writer.Write([]string{item.OccurredAt.Format(time.RFC3339), item.Actor.DisplayName, item.Actor.Source, item.Action, item.ResourceType, item.ResourceID, item.Outcome, strconv.Itoa(item.Status), strconv.FormatInt(item.DurationMs, 10), item.RequestID, item.RemoteIP})
		}
		writer.Flush()
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="audit-events.json"`)
	w.Header().Set("X-Audit-Truncated", strconv.FormatBool(truncated))
	writeAuditJSON(w, http.StatusOK, map[string]any{"items": items, "truncated": truncated})
}

func filterFromRequest(r *http.Request, defaultLimit int) Filter {
	query := r.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	if limit == 0 {
		limit = defaultLimit
	}
	return Filter{From: parseTime(query.Get("from")), To: parseTime(query.Get("to")), Actor: strings.TrimSpace(query.Get("actor")), Action: strings.TrimSpace(query.Get("action")), Outcome: strings.TrimSpace(query.Get("outcome")), ResourceType: strings.TrimSpace(query.Get("resourceType")), ResourceID: strings.TrimSpace(query.Get("resourceId")), Cursor: strings.TrimSpace(query.Get("cursor")), Limit: limit}
}
func parseTime(value string) time.Time { parsed, _ := time.Parse(time.RFC3339, value); return parsed }
func writeAuditJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
