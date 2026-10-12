// Package tasks tells the browser which task Sandboxes, events and scheduler
// runs belong to.
//
// A task lives in the payload of the webhook event that triggered the work.
// The backend proxy strips those payloads from browser responses, so these
// handlers read them server-side and return only the configured title and link.
package tasks

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"agent-compose-ui/internal/config"
)

const (
	backendRequestTimeout = 30 * time.Second
	backendConcurrency    = 8
	maxRequestBytes       = 1 << 20
	maxResponseBytes      = 32 << 20
	maxLookupItems        = 500
)

type Handler struct {
	backend *url.URL
	client  *http.Client
	fields  []config.SandboxTaskField
	mux     *http.ServeMux
	now     func() time.Time
	list    listCache
}

func New(backend *url.URL, fields []config.SandboxTaskField) *Handler {
	h := &Handler{
		backend: backend,
		client:  &http.Client{Timeout: backendRequestTimeout},
		fields:  fields,
		mux:     http.NewServeMux(),
		now:     time.Now,
	}
	h.mux.HandleFunc("GET /api/ui/v1/tasks", h.listTasks)
	h.mux.HandleFunc("POST /api/ui/v1/sandbox-tasks", h.sandboxTasks)
	h.mux.HandleFunc("POST /api/ui/v1/event-tasks", h.eventTasks)
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.mux.ServeHTTP(w, r) }

// connect calls a ProjectService method with the Connect JSON protocol.
func (h *Handler) connect(ctx context.Context, method string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	target := *h.backend
	target.Path = "/agentcompose.v2.ProjectService/" + method
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	return h.do(request, output)
}

func (h *Handler) get(ctx context.Context, path string, output any) error {
	target := *h.backend
	target.Path = path
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return err
	}
	return h.do(request, output)
}

func (h *Handler) do(request *http.Request, output any) error {
	result, err := h.client.Do(request)
	if err != nil {
		return err
	}
	defer result.Body.Close()
	data, err := io.ReadAll(io.LimitReader(result.Body, maxResponseBytes+1))
	if err != nil {
		return err
	}
	if len(data) > maxResponseBytes {
		return fmt.Errorf("backend response too large")
	}
	if result.StatusCode != http.StatusOK {
		message := strings.TrimSpace(string(data))
		if message == "" {
			message = result.Status
		}
		return fmt.Errorf("%s", message)
	}
	return json.Unmarshal(data, output)
}

// forEach runs work for every index with bounded concurrency and returns the
// first error.
func forEach(count int, work func(index int) error) error {
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		first error
	)
	slots := make(chan struct{}, backendConcurrency)
	for index := 0; index < count; index++ {
		wg.Add(1)
		slots <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			if err := work(index); err != nil {
				mu.Lock()
				if first == nil {
					first = err
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return first
}

// taskFromPayload tries each configured field in order and returns the first
// one whose title path resolves to a non-empty string.
func taskFromPayload(payload any, fields []config.SandboxTaskField) (title, link string, ok bool) {
	for _, field := range fields {
		if title := textAt(payload, field.Title); title != "" {
			return title, externalLink(textAt(payload, field.URL)), true
		}
	}
	return "", "", false
}

func parsePayload(payloadJSON string) any {
	if strings.TrimSpace(payloadJSON) == "" {
		return nil
	}
	var payload any
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return nil
	}
	return payload
}

func textAt(value any, path string) string {
	if path == "" {
		return ""
	}
	for _, key := range strings.Split(path, ".") {
		object, isObject := value.(map[string]any)
		if !isObject {
			return ""
		}
		value = object[key]
	}
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

// externalLink keeps only absolute http(s) links: the payload comes from an
// external system and the browser renders this value as an href.
func externalLink(value string) string {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return ""
	}
	return parsed.String()
}

func decodeBody(r *http.Request, output any) error {
	return json.NewDecoder(io.LimitReader(r.Body, maxRequestBytes)).Decode(output)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
