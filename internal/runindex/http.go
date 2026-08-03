package runindex

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const upstreamPageSize = 200
const maxResponseBytes = 16 << 20

type Handler struct {
	backend *url.URL
	client  *http.Client
}

type listRunsResponse struct {
	Runs  []json.RawMessage `json:"runs"`
	Total int               `json:"total"`
}

func New(backend *url.URL) *Handler {
	return &Handler{backend: backend, client: &http.Client{}}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.Path != "/api/ui/v1/runs/unlinked" {
		http.NotFound(w, r)
		return
	}
	limit := queryInt(r, "limit", 50)
	if limit < 1 || limit > 100 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "limit is invalid"})
		return
	}
	cursor := queryInt(r, "cursor", 0)
	if cursor < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cursor is invalid"})
		return
	}
	items, next, more, err := h.scan(r, cursor, limit)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "nextCursor": next, "hasMore": more})
}

func (h *Handler) scan(r *http.Request, cursor, limit int) ([]json.RawMessage, int, bool, error) {
	items := make([]json.RawMessage, 0, limit)
	offset := cursor
	for {
		page, err := h.listRuns(r, offset)
		if err != nil {
			return nil, 0, false, err
		}
		for index, raw := range page.Runs {
			offset++
			var summary struct {
				SandboxID string `json:"sandboxId"`
			}
			if err := json.Unmarshal(raw, &summary); err != nil {
				return nil, 0, false, fmt.Errorf("后端运行数据无效")
			}
			if strings.TrimSpace(summary.SandboxID) != "" {
				continue
			}
			items = append(items, raw)
			if len(items) == limit {
				return items, offset, offset < page.Total || index+1 < len(page.Runs), nil
			}
		}
		if offset >= page.Total || len(page.Runs) == 0 {
			return items, offset, false, nil
		}
	}
}

func (h *Handler) listRuns(r *http.Request, offset int) (listRunsResponse, error) {
	body, _ := json.Marshal(map[string]int{"offset": offset, "limit": upstreamPageSize})
	target := *h.backend
	target.Path = "/agentcompose.v2.RunService/ListRuns"
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return listRunsResponse{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := h.client.Do(request)
	if err != nil {
		return listRunsResponse{}, fmt.Errorf("后端服务不可用")
	}
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(data) > maxResponseBytes {
		return listRunsResponse{}, fmt.Errorf("后端响应读取失败")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return listRunsResponse{}, fmt.Errorf("后端运行查询失败")
	}
	var page listRunsResponse
	if err := json.Unmarshal(data, &page); err != nil {
		return listRunsResponse{}, fmt.Errorf("后端运行数据无效")
	}
	return page, nil
}

func queryInt(r *http.Request, name string, fallback int) int {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return -1
	}
	return value
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
