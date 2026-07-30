package projectfiles

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const maxJSONBytes int64 = 1 << 20
const multipartOverhead int64 = 64 << 10

var skillNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)

type Handler struct {
	storage     *Storage
	readTimeout time.Duration
}

func NewHandler(storage *Storage) *Handler {
	if storage == nil {
		storage = &Storage{}
	}
	return &Handler{storage: storage, readTimeout: 30 * time.Second}
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
	case "/api/project-files/skills":
		if r.Method != http.MethodGet {
			methodError(w, http.MethodGet)
			return
		}
		h.list(w, r)
	case "/api/project-files/skills/create":
		if r.Method != http.MethodPost {
			methodError(w, http.MethodPost)
			return
		}
		h.create(w, r)
	case "/api/project-files/file":
		switch r.Method {
		case http.MethodGet:
			h.read(w, r)
		case http.MethodPut, http.MethodPost:
			h.write(w, r)
		case http.MethodDelete:
			h.removeFile(w, r)
		default:
			methodError(w, http.MethodGet, http.MethodPut, http.MethodPost, http.MethodDelete)
		}
	case "/api/project-files/folder":
		switch r.Method {
		case http.MethodPost:
			h.mkdir(w, r)
		case http.MethodDelete:
			h.removeFolder(w, r)
		default:
			methodError(w, http.MethodPost, http.MethodDelete)
		}
	case "/api/project-files/upload":
		if r.Method != http.MethodPost {
			methodError(w, http.MethodPost)
			return
		}
		h.upload(w, r)
	case "/api/project-files/download":
		if r.Method != http.MethodGet {
			methodError(w, http.MethodGet)
			return
		}
		h.download(w, r)
	default:
		writeAPIError(w, http.StatusNotFound, "not_found", "not found")
	}
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	q, ok := queryParams(w, r, map[string]bool{"projectKey": true, "path": false})
	if !ok {
		return
	}
	entries, err := h.storage.List(q["projectKey"], "skills", q["path"])
	if err != nil {
		writeStorageAPIError(w, err)
		return
	}
	writeJSONResponse(w, http.StatusOK, map[string]any{"entries": entries})
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ProjectKey string `json:"projectKey"`
		Name       string `json:"name"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if !skillNamePattern.MatchString(body.Name) {
		writeAPIError(w, 400, "invalid_request", "invalid skill name")
		return
	}
	template := fmt.Sprintf("---\nname: %s\ndescription: 请填写 Skill 的用途\n---\n\n请在这里编写 Skill 指令。\n", body.Name)
	file, err := h.storage.CreateDirectoryFile(body.ProjectKey, "skills", body.Name, "SKILL.md", []byte(template))
	if err != nil {
		writeStorageAPIError(w, err)
		return
	}
	writeJSONResponse(w, http.StatusCreated, map[string]any{"file": fileMetadata(file)})
}

func (h *Handler) read(w http.ResponseWriter, r *http.Request) {
	q, ok := queryParams(w, r, map[string]bool{"projectKey": true, "path": true})
	if !ok {
		return
	}
	file, err := h.storage.Read(q["projectKey"], "skills", q["path"])
	if err != nil {
		writeStorageAPIError(w, err)
		return
	}
	if !utf8.Valid(file.Content) {
		writeAPIError(w, 400, "invalid_text", "file is not valid UTF-8")
		return
	}
	writeJSONResponse(w, 200, map[string]any{"file": textFile(file)})
}

func (h *Handler) write(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ProjectKey     string `json:"projectKey"`
		Path           string `json:"path"`
		Content        string `json:"content"`
		ExpectedSHA256 string `json:"expectedSHA256"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if !utf8.ValidString(body.Content) {
		writeAPIError(w, 400, "invalid_text", "content is not valid UTF-8")
		return
	}
	file, err := h.storage.Write(body.ProjectKey, "skills", body.Path, []byte(body.Content), body.ExpectedSHA256)
	if err != nil {
		writeStorageAPIError(w, err)
		return
	}
	writeJSONResponse(w, 200, map[string]any{"file": fileMetadata(file)})
}

func (h *Handler) removeFile(w http.ResponseWriter, r *http.Request) {
	q, ok := queryParams(w, r, map[string]bool{"projectKey": true, "path": true})
	if !ok {
		return
	}
	if err := h.storage.Remove(q["projectKey"], "skills", q["path"], false); err != nil {
		writeStorageAPIError(w, err)
		return
	}
	w.WriteHeader(204)
}
func (h *Handler) mkdir(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ProjectKey string `json:"projectKey"`
		Path       string `json:"path"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := h.storage.Mkdir(body.ProjectKey, "skills", body.Path); err != nil {
		writeStorageAPIError(w, err)
		return
	}
	writeJSONResponse(w, 201, map[string]any{"path": body.Path})
}
func (h *Handler) removeFolder(w http.ResponseWriter, r *http.Request) {
	q, ok := queryParams(w, r, map[string]bool{"projectKey": true, "path": true, "recursive": true})
	if !ok {
		return
	}
	if q["recursive"] != "true" && q["recursive"] != "false" {
		writeAPIError(w, 400, "invalid_request", "recursive must be true or false")
		return
	}
	recursive := q["recursive"] == "true"
	if err := h.storage.Remove(q["projectKey"], "skills", q["path"], recursive); err != nil {
		writeStorageAPIError(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *Handler) upload(w http.ResponseWriter, r *http.Request) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		writeAPIError(w, 415, "unsupported_media_type", "multipart/form-data required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, h.storage.maxBytes()+multipartOverhead)
	mr, err := r.MultipartReader()
	if err != nil {
		writeMultipartError(w, err)
		return
	}
	var projectKey, target string
	var data []byte
	seen := map[string]bool{}
	for {
		part, e := mr.NextPart()
		if errors.Is(e, io.EOF) {
			break
		}
		if e != nil {
			writeMultipartError(w, e)
			return
		}
		name := part.FormName()
		if seen[name] {
			_ = part.Close()
			writeAPIError(w, 400, "invalid_request", "duplicate multipart field")
			return
		}
		seen[name] = true
		switch name {
		case "projectKey":
			projectKey, e = readSmall(part, 256)
		case "path":
			target, e = readSmall(part, MaxRelativePathBytes+1)
		case "file":
			data, e = io.ReadAll(io.LimitReader(part, h.storage.maxBytes()+1))
			if int64(len(data)) > h.storage.maxBytes() {
				e = ErrTooLarge
			}
		default:
			e = errors.New("unknown multipart field")
		}
		_ = part.Close()
		if e != nil {
			writeMultipartError(w, e)
			return
		}
	}
	clearReadDeadline(w, r)
	if !seen["file"] || !seen["projectKey"] || !seen["path"] || projectKey == "" || target == "" || !utf8.ValidString(projectKey) || !utf8.ValidString(target) {
		writeAPIError(w, 400, "invalid_request", "missing or invalid multipart field")
		return
	}
	file, err := h.storage.Write(projectKey, "skills", target, data, "")
	if err != nil {
		writeStorageAPIError(w, err)
		return
	}
	writeJSONResponse(w, 201, map[string]any{"file": fileMetadata(file)})
}

func (h *Handler) download(w http.ResponseWriter, r *http.Request) {
	q, ok := queryParams(w, r, map[string]bool{"projectKey": true, "path": true})
	if !ok {
		return
	}
	file, err := h.storage.Read(q["projectKey"], "skills", q["path"])
	if err != nil {
		writeStorageAPIError(w, err)
		return
	}
	name := path.Base(file.Path)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("Content-Type", http.DetectContentType(file.Content))
	w.Header().Set("Content-Length", strconv.FormatInt(file.Size, 10))
	w.Header().Set("ETag", `"`+file.SHA256+`"`)
	if etagMatches(r.Header.Get("If-None-Match"), file.SHA256) {
		w.Header().Del("Content-Length")
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(200)
	_, _ = w.Write(file.Content)
}

func readSmall(r io.Reader, limit int) (string, error) {
	b, err := io.ReadAll(io.LimitReader(r, int64(limit)))
	if err != nil {
		return "", err
	}
	if len(b) >= limit {
		return "", ErrTooLarge
	}
	return string(b), nil
}

func queryParams(w http.ResponseWriter, r *http.Request, schema map[string]bool) (map[string]string, bool) {
	parsed, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeAPIError(w, 400, "invalid_request", "invalid query parameters")
		return nil, false
	}
	result := make(map[string]string, len(schema))
	for key, values := range parsed {
		required, known := schema[key]
		_ = required
		if !known || len(values) != 1 {
			writeAPIError(w, 400, "invalid_request", "invalid query parameters")
			return nil, false
		}
		result[key] = values[0]
	}
	for key, required := range schema {
		if required && result[key] == "" {
			writeAPIError(w, 400, "invalid_request", "missing query parameter")
			return nil, false
		}
	}
	return result, true
}

func rejectDuplicateJSONKeys(raw []byte) error {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	var scan func() error
	scan = func() error {
		token, err := dec.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]struct{}{}
			for dec.More() {
				keyToken, err := dec.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return errors.New("invalid object key")
				}
				if _, exists := seen[key]; exists {
					return errors.New("duplicate object key")
				}
				seen[key] = struct{}{}
				if err := scan(); err != nil {
					return err
				}
			}
			_, err = dec.Token()
			return err
		case '[':
			for dec.More() {
				if err := scan(); err != nil {
					return err
				}
			}
			_, err = dec.Token()
			return err
		default:
			return errors.New("unexpected delimiter")
		}
	}
	if err := scan(); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}

func etagMatches(header, sha string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" {
			return true
		}
		candidate = strings.TrimPrefix(candidate, "W/")
		if candidate == `"`+sha+`"` {
			return true
		}
	}
	return false
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeAPIError(w, 415, "unsupported_media_type", "application/json required")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBytes)
	raw, err := io.ReadAll(r.Body)
	clearReadDeadline(w, r)
	if err != nil {
		if isBodyTooLarge(err) {
			writeAPIError(w, 413, "too_large", "request body too large")
		} else if timeoutError(err) {
			writeAPIError(w, http.StatusRequestTimeout, "request_timeout", "request body timed out")
		} else {
			writeAPIError(w, 400, "invalid_request", "invalid JSON body")
		}
		return false
	}
	if !utf8.Valid(raw) {
		writeAPIError(w, 400, "invalid_request", "invalid UTF-8 JSON body")
		return false
	}
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		writeAPIError(w, 400, "invalid_request", "invalid JSON body")
		return false
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err = dec.Decode(target); err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			writeAPIError(w, 413, "too_large", "request body too large")
		} else {
			writeAPIError(w, 400, "invalid_request", "invalid JSON body")
		}
		return false
	}
	var extra any
	if err = dec.Decode(&extra); !errors.Is(err, io.EOF) {
		writeAPIError(w, 400, "invalid_request", "JSON body must contain one value")
		return false
	}
	return true
}

func clearReadDeadline(w http.ResponseWriter, r *http.Request) {
	_ = http.NewResponseController(w).SetReadDeadline(time.Time{})
	if setter, ok := r.Body.(interface{ SetReadDeadline(time.Time) error }); ok {
		_ = setter.SetReadDeadline(time.Time{})
	}
}

func timeoutError(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func isBodyTooLarge(err error) bool {
	var maxErr *http.MaxBytesError
	return errors.Is(err, ErrTooLarge) || errors.As(err, &maxErr)
}

func writeMultipartError(w http.ResponseWriter, err error) {
	if isBodyTooLarge(err) {
		writeAPIError(w, 413, "too_large", "multipart body too large")
		return
	}
	if timeoutError(err) {
		writeAPIError(w, http.StatusRequestTimeout, "request_timeout", "request body timed out")
		return
	}
	writeAPIError(w, 400, "invalid_request", "invalid multipart upload")
}
func textFile(f File) map[string]any {
	m := fileMetadata(f)
	m["content"] = string(f.Content)
	return m
}
func fileMetadata(f File) map[string]any {
	return map[string]any{"path": f.Path, "name": f.Name, "isDir": f.IsDir, "size": f.Size, "modTime": f.ModTime, "sha256": f.SHA256}
}
func methodError(w http.ResponseWriter, methods ...string) {
	w.Header().Set("Allow", strings.Join(methods, ", "))
	writeAPIError(w, 405, "method_not_allowed", "method not allowed")
}
func writeJSONResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSONResponse(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func writeStorageAPIError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrCommitUncertain):
		writeAPIError(w, 503, "commit_uncertain", "write may have committed; verify before retrying")
	case errors.Is(err, ErrInvalidProject) || errors.Is(err, ErrInvalidResource) || errors.Is(err, ErrInvalidPath):
		writeAPIError(w, 400, "invalid_request", "invalid project file request")
	case errors.Is(err, ErrInvalidChecksum):
		writeAPIError(w, 400, "invalid_request", "invalid expectedSHA256")
	case errors.Is(err, ErrUnsafePath):
		writeAPIError(w, 400, "unsafe_path", "unsafe project file path")
	case errors.Is(err, ErrNotFound):
		writeAPIError(w, 404, "not_found", "project file not found")
	case errors.Is(err, ErrConflict) || errors.Is(err, ErrTypeConflict):
		writeAPIError(w, 409, "conflict", "project file conflict")
	case errors.Is(err, ErrTooLarge) || errors.Is(err, ErrLimitExceeded):
		writeAPIError(w, 413, "too_large", "project file limit exceeded")
	default:
		writeAPIError(w, 500, "storage_error", "project file storage unavailable")
	}
}
