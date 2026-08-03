package agentrecords

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	routeMarker       = "/agent-records"
	defaultChunkBytes = 256 << 10
	maxChunkBytes     = 1 << 20
)

var allowedRoots = []struct {
	provider string
	relative string
}{
	{provider: "codex", relative: "home/.codex/sessions"},
	{provider: "claude", relative: "home/.claude/projects"},
}

type Handler struct {
	root string
}

type Record struct {
	ID         string    `json:"id"`
	Provider   string    `json:"provider"`
	Path       string    `json:"path"`
	Size       int64     `json:"size"`
	ModifiedAt time.Time `json:"modifiedAt"`
}

type chunkResponse struct {
	Record     Record `json:"record"`
	Content    string `json:"content"`
	Start      int64  `json:"startOffset"`
	End        int64  `json:"endOffset"`
	Total      int64  `json:"totalBytes"`
	HasEarlier bool   `json:"hasEarlier"`
}

func New(root string) *Handler {
	return &Handler{root: filepath.Clean(strings.TrimSpace(root))}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	sandboxID, recordID, ok := parsePath(r.URL.Path)
	if !ok || !validSandboxID(sandboxID) {
		http.NotFound(w, r)
		return
	}
	sandboxDir, err := h.findSandbox(sandboxID)
	if err != nil {
		writeError(w, http.StatusNotFound, "找不到执行环境记录")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if recordID == "" {
		h.list(w, sandboxDir)
		return
	}
	h.read(w, r, sandboxDir, recordID)
}

func (h *Handler) list(w http.ResponseWriter, sandboxDir string) {
	records := make([]Record, 0)
	for _, root := range allowedRoots {
		base := filepath.Join(sandboxDir, filepath.FromSlash(root.relative))
		_ = filepath.WalkDir(base, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				if errors.Is(walkErr, os.ErrNotExist) {
					return nil
				}
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.IsDir() || !entry.Type().IsRegular() || !strings.EqualFold(filepath.Ext(path), ".jsonl") {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return nil
			}
			relative, err := filepath.Rel(sandboxDir, path)
			if err != nil {
				return nil
			}
			records = append(records, recordFromFile(root.provider, filepath.ToSlash(relative), info))
			return nil
		})
	}
	sort.Slice(records, func(i, j int) bool { return records[i].ModifiedAt.After(records[j].ModifiedAt) })
	writeJSON(w, http.StatusOK, map[string]any{"items": records})
}

func (h *Handler) read(w http.ResponseWriter, r *http.Request, sandboxDir, recordID string) {
	record, path, file, err := openRecord(sandboxDir, recordID)
	if err != nil {
		writeError(w, http.StatusNotFound, "找不到 Agent 记录")
		return
	}
	defer func() { _ = file.Close() }()
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(path)))
		_, _ = io.Copy(w, file)
		return
	}
	limit := queryInt64(r, "limit", defaultChunkBytes)
	if limit < 1 || limit > maxChunkBytes {
		writeError(w, http.StatusBadRequest, "读取大小无效")
		return
	}
	before := queryInt64(r, "before", record.Size)
	if before < 0 || before > record.Size {
		writeError(w, http.StatusBadRequest, "读取位置无效")
		return
	}
	start := max(before-limit, 0)
	start = utf8Start(file, start)
	data := make([]byte, before-start)
	if _, err := file.ReadAt(data, start); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusInternalServerError, "读取 Agent 记录失败")
		return
	}
	writeJSON(w, http.StatusOK, chunkResponse{
		Record: record, Content: string(data), Start: start, End: before, Total: record.Size, HasEarlier: start > 0,
	})
}

func (h *Handler) findSandbox(id string) (string, error) {
	candidates := []string{filepath.Join(h.root, id)}
	partitioned, _ := filepath.Glob(filepath.Join(h.root, "[0-9][0-9][0-9][0-9]", "[0-9][0-9]", "[0-9][0-9]", id))
	candidates = append(candidates, partitioned...)
	rootReal, err := filepath.EvalSymlinks(h.root)
	if err != nil {
		return "", err
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err != nil || !info.IsDir() {
			continue
		}
		real, err := filepath.EvalSymlinks(candidate)
		if err == nil && within(rootReal, real) {
			return real, nil
		}
	}
	return "", os.ErrNotExist
}

func openRecord(sandboxDir, id string) (Record, string, *os.File, error) {
	raw, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		return Record{}, "", nil, err
	}
	relative := filepath.Clean(filepath.FromSlash(string(raw)))
	provider, ok := allowedRecordPath(filepath.ToSlash(relative))
	if !ok || filepath.IsAbs(relative) {
		return Record{}, "", nil, os.ErrPermission
	}
	path := filepath.Join(sandboxDir, relative)
	if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
		return Record{}, "", nil, os.ErrNotExist
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || !within(sandboxDir, real) {
		return Record{}, "", nil, os.ErrPermission
	}
	file, err := os.Open(real)
	if err != nil {
		return Record{}, "", nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return Record{}, "", nil, err
	}
	return recordFromFile(provider, filepath.ToSlash(relative), info), real, file, nil
}

func recordFromFile(provider, relative string, info os.FileInfo) Record {
	return Record{
		ID:         base64.RawURLEncoding.EncodeToString([]byte(relative)),
		Provider:   provider,
		Path:       strings.TrimPrefix(relative, "home/"),
		Size:       info.Size(),
		ModifiedAt: info.ModTime().UTC(),
	}
}

func allowedRecordPath(relative string) (string, bool) {
	if !strings.EqualFold(filepath.Ext(relative), ".jsonl") {
		return "", false
	}
	for _, root := range allowedRoots {
		if strings.HasPrefix(relative, root.relative+"/") {
			return root.provider, true
		}
	}
	return "", false
}

func parsePath(path string) (string, string, bool) {
	const prefix = "/api/ui/v1/sandboxes/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(path, prefix)
	index := strings.Index(rest, routeMarker)
	if index < 1 {
		return "", "", false
	}
	sandboxID := strings.TrimSuffix(rest[:index], "/")
	tail := strings.TrimPrefix(rest[index+len(routeMarker):], "/")
	if strings.Contains(tail, "/") {
		return "", "", false
	}
	return sandboxID, tail, true
}

func validSandboxID(value string) bool {
	if len(value) < 8 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' {
			return false
		}
	}
	return true
}

func within(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func utf8Start(file *os.File, offset int64) int64 {
	for offset > 0 {
		byteAt := []byte{0}
		if _, err := file.ReadAt(byteAt, offset); err != nil || utf8.RuneStart(byteAt[0]) {
			break
		}
		offset--
	}
	return offset
}

func queryInt64(r *http.Request, name string, fallback int64) int64 {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return -1
	}
	return value
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
