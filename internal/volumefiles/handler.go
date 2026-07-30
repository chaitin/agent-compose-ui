package volumefiles

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const maxInspectorResponse = 1 << 20

type DaemonInspector struct {
	base   *url.URL
	client *http.Client
}

func NewDaemonInspector(base *url.URL, client *http.Client) *DaemonInspector {
	if client == nil {
		client = http.DefaultClient
	}
	clientCopy := *client
	clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	var copied *url.URL
	if base != nil && (base.Scheme == "http" || base.Scheme == "https") && base.Host != "" && base.User == nil && base.RawQuery == "" && base.Fragment == "" {
		v := *base
		copied = &v
	}
	return &DaemonInspector{base: copied, client: &clientCopy}
}

func (d *DaemonInspector) InspectVolume(ctx context.Context, name string) (Volume, error) {
	if d == nil || d.base == nil || d.client == nil {
		return Volume{}, ErrUnavailable
	}
	u := *d.base
	u.Path = strings.TrimRight(u.Path, "/") + "/agentcompose.v2.VolumeService/InspectVolume"
	u.RawQuery = ""
	u.Fragment = ""
	var body bytes.Buffer
	_ = json.NewEncoder(&body).Encode(struct {
		Name string `json:"name"`
	}{name})
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), &body)
	if e != nil {
		return Volume{}, ErrUpstream
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	resp, e := d.client.Do(req)
	if e != nil {
		if ctx.Err() != nil {
			return Volume{}, ctx.Err()
		}
		return Volume{}, ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return Volume{}, ErrNotFound
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return Volume{}, ErrUpstream
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Volume{}, ErrUnavailable
	}
	media, params, mediaErr := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if mediaErr != nil || media != "application/json" {
		return Volume{}, ErrUpstream
	}
	for k, v := range params {
		if !strings.EqualFold(k, "charset") || !strings.EqualFold(v, "utf-8") {
			return Volume{}, ErrUpstream
		}
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, maxInspectorResponse+1))
	if e != nil || len(b) > maxInspectorResponse {
		return Volume{}, ErrUpstream
	}
	var wire struct {
		Volume *struct {
			Name      string            `json:"name"`
			Driver    string            `json:"driver"`
			Path      string            `json:"path"`
			Labels    map[string]string `json:"labels"`
			ProjectID string            `json:"projectId"`
		} `json:"volume"`
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	if e = dec.Decode(&wire); e != nil || wire.Volume == nil {
		return Volume{}, ErrUpstream
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		return Volume{}, ErrUpstream
	}
	return Volume{Name: wire.Volume.Name, Driver: wire.Volume.Driver, Path: wire.Volume.Path, Labels: wire.Volume.Labels, ProjectID: wire.Volume.ProjectID}, nil
}

type Handler struct {
	storage     *Storage
	resolver    *Resolver
	readTimeout time.Duration
}

func NewHandler(storage *Storage, resolver *Resolver) *Handler {
	if storage == nil {
		storage = &Storage{}
	}
	return &Handler{storage: storage, resolver: resolver, readTimeout: 30 * time.Second}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Body != nil && h.readTimeout > 0 && (r.Method == http.MethodPost || r.Method == http.MethodPut) {
		deadline := time.Now().Add(h.readTimeout)
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(deadline)
		if setter, ok := r.Body.(interface{ SetReadDeadline(time.Time) error }); ok {
			_ = setter.SetReadDeadline(deadline)
			defer setter.SetReadDeadline(time.Time{})
		}
		defer controller.SetReadDeadline(time.Time{})
	}
	switch r.URL.Path {
	case "/api/volume-files":
		if r.Method != http.MethodGet {
			method(w, http.MethodGet)
			return
		}
		h.list(w, r)
	case "/api/volume-files/preview":
		if r.Method != http.MethodGet {
			method(w, http.MethodGet)
			return
		}
		h.preview(w, r)
	case "/api/volume-files/download":
		if r.Method != http.MethodGet {
			method(w, http.MethodGet)
			return
		}
		h.download(w, r)
	case "/api/volume-files/upload":
		if r.Method != http.MethodPost {
			method(w, http.MethodPost)
			return
		}
		h.upload(w, r)
	case "/api/volume-files/file":
		switch r.Method {
		case http.MethodPut:
			if !requireJSONMedia(w, r) {
				return
			}
			h.write(w, r)
		case http.MethodDelete:
			h.remove(w, r, false)
		default:
			method(w, http.MethodPut, http.MethodDelete)
		}
	case "/api/volume-files/folder":
		switch r.Method {
		case http.MethodPost:
			if !requireJSONMedia(w, r) {
				return
			}
			h.mkdir(w, r)
		case http.MethodDelete:
			h.remove(w, r, true)
		default:
			method(w, http.MethodPost, http.MethodDelete)
		}
	default:
		apiError(w, 404, "not_found", "not found")
	}
}

func requireJSONMedia(w http.ResponseWriter, r *http.Request) bool {
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		apiError(w, 415, "unsupported_media_type", "application/json required")
		return false
	}
	for k, v := range params {
		if !strings.EqualFold(k, "charset") || !strings.EqualFold(v, "utf-8") {
			apiError(w, 415, "unsupported_media_type", "application/json required")
			return false
		}
	}
	return true
}
func method(w http.ResponseWriter, allow ...string) {
	w.Header().Set("Allow", strings.Join(allow, ", "))
	apiError(w, 405, "method_not_allowed", "method not allowed")
}
func apiError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func jsonResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func strictQuery(w http.ResponseWriter, r *http.Request, required map[string]bool) (map[string]string, bool) {
	q, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		apiError(w, 400, "invalid_request", "invalid query")
		return nil, false
	}
	out := map[string]string{}
	for k, v := range q {
		need, ok := required[k]
		if !ok || len(v) != 1 || v[0] == "" && need {
			apiError(w, 400, "invalid_request", "invalid query")
			return nil, false
		}
		out[k] = v[0]
	}
	for k, need := range required {
		if need && out[k] == "" {
			apiError(w, 400, "invalid_request", "invalid query")
			return nil, false
		}
	}
	return out, true
}
func (h *Handler) resolve(w http.ResponseWriter, r *http.Request, q map[string]string) (string, bool) {
	if h.resolver == nil {
		apiError(w, 503, "unavailable", "volume files unavailable")
		return "", false
	}
	root, e := h.resolver.Resolve(r.Context(), q["projectKey"], q["volume"])
	if e != nil {
		storageAPIError(w, e)
		return "", false
	}
	return root, true
}
func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	q, ok := strictQuery(w, r, map[string]bool{"projectKey": true, "volume": true, "path": false})
	if !ok {
		return
	}
	root, ok := h.resolve(w, r, q)
	if !ok {
		return
	}
	v, e := h.storage.List(r.Context(), root, q["path"])
	if e != nil {
		storageAPIError(w, e)
		return
	}
	jsonResponse(w, 200, map[string]any{"entries": v})
}
func (h *Handler) preview(w http.ResponseWriter, r *http.Request) {
	q, ok := strictQuery(w, r, map[string]bool{"projectKey": true, "volume": true, "path": true})
	if !ok {
		return
	}
	root, ok := h.resolve(w, r, q)
	if !ok {
		return
	}
	v, e := h.storage.Preview(r.Context(), root, q["path"])
	if e != nil {
		storageAPIError(w, e)
		return
	}
	jsonResponse(w, 200, v)
}
func (h *Handler) download(w http.ResponseWriter, r *http.Request) {
	q, ok := strictQuery(w, r, map[string]bool{"projectKey": true, "volume": true, "path": true})
	if !ok {
		return
	}
	root, ok := h.resolve(w, r, q)
	if !ok {
		return
	}
	f, e := h.storage.Read(r.Context(), root, q["path"])
	if e != nil {
		storageAPIError(w, e)
		return
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(f.Path)}))
	w.Header().Set("Content-Type", http.DetectContentType(f.Content))
	w.Header().Set("Content-Length", strconv.FormatInt(f.Size, 10))
	w.Header().Set("ETag", `"`+f.SHA256+`"`)
	if etag(r.Header.Get("If-None-Match"), f.SHA256) {
		w.Header().Del("Content-Length")
		w.WriteHeader(304)
		return
	}
	w.WriteHeader(200)
	_, _ = w.Write(f.Content)
}
func etag(header, sum string) bool {
	for _, v := range strings.Split(header, ",") {
		v = strings.TrimSpace(v)
		if v == "*" || v == `"`+sum+`"` {
			return true
		}
	}
	return false
}

type writeBody struct {
	ProjectKey     string `json:"projectKey"`
	Volume         string `json:"volume"`
	Path           string `json:"path"`
	Content        string `json:"content"`
	ExpectedSHA256 string `json:"expectedSHA256"`
}
type folderBody struct {
	ProjectKey string `json:"projectKey"`
	Volume     string `json:"volume"`
	Path       string `json:"path"`
}

func decodeObject(w http.ResponseWriter, r *http.Request, allowed map[string]bool, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, defaultMaxFileBytes+(64<<10))
	dec := json.NewDecoder(r.Body)
	t, e := dec.Token()
	if e != nil || t != json.Delim('{') {
		jsonDecodeError(w, e)
		return false
	}
	raw := map[string]json.RawMessage{}
	for dec.More() {
		t, e = dec.Token()
		if e != nil {
			jsonDecodeError(w, e)
			return false
		}
		k, ok := t.(string)
		if !ok || !allowed[k] {
			apiError(w, 400, "invalid_request", "invalid JSON")
			return false
		}
		if _, exists := raw[k]; exists {
			apiError(w, 400, "invalid_request", "duplicate JSON field")
			return false
		}
		var v json.RawMessage
		if e = dec.Decode(&v); e != nil {
			jsonDecodeError(w, e)
			return false
		}
		raw[k] = v
	}
	if _, e = dec.Token(); e != nil {
		jsonDecodeError(w, e)
		return false
	}
	if e = dec.Decode(&struct{}{}); e != io.EOF {
		jsonDecodeError(w, e)
		return false
	}
	b, _ := json.Marshal(raw)
	if !utf8.Valid(b) || json.Unmarshal(b, out) != nil {
		apiError(w, 400, "invalid_request", "invalid JSON")
		return false
	}
	return true
}

func jsonDecodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		apiError(w, 413, "too_large", "request too large")
		return
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		apiError(w, http.StatusRequestTimeout, "timeout", "request timed out")
		return
	}
	apiError(w, 400, "invalid_request", "invalid JSON")
}
func (h *Handler) write(w http.ResponseWriter, r *http.Request) {
	var b writeBody
	if !decodeObject(w, r, map[string]bool{"projectKey": true, "volume": true, "path": true, "content": true, "expectedSHA256": true}, &b) {
		return
	}
	if b.ProjectKey == "" || b.Volume == "" || b.Path == "" || !utf8.ValidString(b.Content) {
		apiError(w, 400, "invalid_request", "invalid request")
		return
	}
	root, ok := h.resolve(w, r, map[string]string{"projectKey": b.ProjectKey, "volume": b.Volume})
	if !ok {
		return
	}
	f, e := h.storage.Write(r.Context(), root, b.Path, []byte(b.Content), b.ExpectedSHA256)
	if e != nil {
		storageAPIError(w, e)
		return
	}
	jsonResponse(w, 200, map[string]any{"file": f})
}
func (h *Handler) mkdir(w http.ResponseWriter, r *http.Request) {
	var b folderBody
	if !decodeObject(w, r, map[string]bool{"projectKey": true, "volume": true, "path": true}, &b) {
		return
	}
	if b.ProjectKey == "" || b.Volume == "" || b.Path == "" {
		apiError(w, 400, "invalid_request", "invalid request")
		return
	}
	root, ok := h.resolve(w, r, map[string]string{"projectKey": b.ProjectKey, "volume": b.Volume})
	if !ok {
		return
	}
	if e := h.storage.Mkdir(r.Context(), root, b.Path); e != nil {
		storageAPIError(w, e)
		return
	}
	jsonResponse(w, 201, map[string]string{"path": b.Path})
}
func (h *Handler) remove(w http.ResponseWriter, r *http.Request, folder bool) {
	spec := map[string]bool{"projectKey": true, "volume": true, "path": true}
	if folder {
		spec["recursive"] = true
	}
	q, ok := strictQuery(w, r, spec)
	if !ok {
		return
	}
	recursive := false
	if folder {
		if q["recursive"] != "true" && q["recursive"] != "false" {
			apiError(w, 400, "invalid_request", "invalid recursive value")
			return
		}
		recursive = q["recursive"] == "true"
	}
	root, ok := h.resolve(w, r, q)
	if !ok {
		return
	}
	var e error
	if folder {
		e = h.storage.RemoveFolder(r.Context(), root, q["path"], recursive)
	} else {
		e = h.storage.RemoveFile(r.Context(), root, q["path"])
	}
	if e != nil {
		storageAPIError(w, e)
		return
	}
	w.WriteHeader(204)
}

func (h *Handler) upload(w http.ResponseWriter, r *http.Request) {
	ct, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if e != nil || ct != "multipart/form-data" {
		apiError(w, 415, "unsupported_media_type", "multipart/form-data required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, h.storage.fileLimit()+(64<<10))
	mr, e := r.MultipartReader()
	if e != nil {
		apiError(w, 400, "invalid_request", "invalid multipart body")
		return
	}
	values := map[string]string{}
	var data []byte
	seen := map[string]bool{}
	for {
		part, e := mr.NextPart()
		if errors.Is(e, io.EOF) {
			break
		}
		if e != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(e, &tooLarge) {
				apiError(w, 413, "too_large", "request too large")
			} else {
				apiError(w, 400, "invalid_request", "invalid multipart body")
			}
			return
		}
		n := part.FormName()
		if seen[n] || !(n == "projectKey" || n == "volume" || n == "path" || n == "file") {
			part.Close()
			apiError(w, 400, "invalid_request", "invalid multipart field")
			return
		}
		seen[n] = true
		if n == "file" {
			data, e = io.ReadAll(io.LimitReader(part, h.storage.fileLimit()+1))
		} else {
			var b []byte
			b, e = io.ReadAll(io.LimitReader(part, MaxRelativePathBytes+1))
			values[n] = string(b)
			if len(b) > MaxRelativePathBytes {
				e = ErrTooLarge
			} else if !utf8.Valid(b) {
				e = ErrInvalidPath
			}
		}
		part.Close()
		if e != nil || int64(len(data)) > h.storage.fileLimit() {
			if errors.Is(e, ErrTooLarge) || int64(len(data)) > h.storage.fileLimit() {
				apiError(w, 413, "too_large", "request too large")
			} else {
				apiError(w, 400, "invalid_request", "invalid multipart field")
			}
			return
		}
	}
	if !seen["projectKey"] || !seen["volume"] || !seen["path"] || !seen["file"] || values["projectKey"] == "" || values["volume"] == "" || values["path"] == "" {
		apiError(w, 400, "invalid_request", "missing multipart field")
		return
	}
	root, ok := h.resolve(w, r, values)
	if !ok {
		return
	}
	f, e := h.storage.Write(r.Context(), root, values["path"], data, "")
	if e != nil {
		storageAPIError(w, e)
		return
	}
	jsonResponse(w, 201, map[string]any{"file": f})
}

func storageAPIError(w http.ResponseWriter, e error) {
	status, code, msg := 500, "storage_error", "storage operation failed"
	switch {
	case errors.Is(e, context.Canceled):
		status, code, msg = 408, "canceled", "request canceled"
	case errors.Is(e, context.DeadlineExceeded):
		status, code, msg = 504, "timeout", "request timed out"
	case errors.Is(e, ErrInvalid), errors.Is(e, ErrInvalidPath):
		status, code, msg = 400, "invalid_request", "invalid request"
	case errors.Is(e, ErrNotFound):
		status, code, msg = 404, "not_found", "not found"
	case errors.Is(e, ErrForbidden), errors.Is(e, ErrUnsafePath):
		status, code, msg = 403, "forbidden", "access forbidden"
	case errors.Is(e, ErrConflict), errors.Is(e, ErrTypeConflict):
		status, code, msg = 409, "conflict", "resource conflict"
	case errors.Is(e, ErrTooLarge), errors.Is(e, ErrLimitExceeded):
		status, code, msg = 413, "too_large", "request too large"
	case errors.Is(e, ErrPartialMutation):
		status, code, msg = 409, "partial_delete", "files may have changed"
	case errors.Is(e, ErrPartialWrite):
		status, code, msg = 409, "partial_mutation", "write may have partially completed"
	case errors.Is(e, ErrCommitUncertain):
		status, code, msg = 503, "commit_uncertain", "verify operation result"
	case errors.Is(e, ErrUnavailable):
		status, code, msg = 503, "unavailable", "volume service unavailable"
	case errors.Is(e, ErrUpstream):
		status, code, msg = 502, "upstream_error", "volume service failure"
	}
	apiError(w, status, code, msg)
}
