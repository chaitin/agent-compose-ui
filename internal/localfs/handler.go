package localfs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const maxUploadBytes = 256 << 20

type FileEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Dir     bool   `json:"dir"`
	Size    int64  `json:"size"`
	MtimeMs int64  `json:"mtimeMs"`
}

type Handler struct{ storage *Storage }

func New(storages ...*Storage) *Handler {
	if len(storages) > 0 && storages[0] != nil {
		return &Handler{storage: storages[0]}
	}
	return &Handler{storage: NewStorage(filepath.Join(os.TempDir(), "agent-compose-ui", "projects"), "")}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	switch {
	case p == "/api/project-storage/bind" && r.Method == http.MethodPost:
		h.bind(w, r)
	case p == "/api/project-storage/resolve" && r.Method == http.MethodPost:
		h.resolve(w, r)
	case p == "/api/local-workspace/files" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		h.listFiles(w, r)
	case p == "/api/local-workspace/upload" && r.Method == http.MethodPost:
		h.uploadFile(w, r)
	case p == "/api/local-workspace/download" && r.Method == http.MethodGet:
		h.downloadFile(w, r)
	case p == "/api/local-workspace/file" && r.Method == http.MethodDelete:
		h.deleteFile(w, r)
	case p == "/api/local-workspace/folder" && r.Method == http.MethodPost:
		h.createFolder(w, r)
	case p == "/api/local-workspace/folder" && r.Method == http.MethodDelete:
		h.deleteFolder(w, r)
	case p == "/api/local-workspace/ensure-dir" && r.Method == http.MethodPost:
		h.ensureDir(w, r)
	default:
		writeError(w, http.StatusNotFound, "not_found", "not found")
	}
}

func (h *Handler) bind(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ProjectKey      string `json:"projectKey"`
		WorkspacePath   string `json:"workspacePath"`
		EnsureWorkspace bool   `json:"ensureWorkspace"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, 400, "invalid_request", "invalid JSON body")
		return
	}
	ensure := body.EnsureWorkspace || body.WorkspacePath != ""
	var binding Binding
	var err error
	if body.ProjectKey == "" {
		binding, err = h.storage.CreateBinding(ensure)
	} else {
		binding, err = h.storage.ResolveBinding(body.ProjectKey, ensure)
	}
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, 200, binding)
}

func (h *Handler) resolve(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SourcePath string `json:"sourcePath"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		writeError(w, 400, "invalid_request", "invalid JSON body")
		return
	}
	binding, err := h.storage.ResolveSourcePath(body.SourcePath)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, 200, binding)
}

func decodeOptionalJSON(r *http.Request, target any) error {
	if r.Body == nil || r.ContentLength == 0 {
		return nil
	}
	err := json.NewDecoder(r.Body).Decode(target)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func workspaceParams(r *http.Request) (string, string) {
	return r.URL.Query().Get("projectKey"), r.URL.Query().Get("workspacePath")
}

func (h *Handler) workspaceRoot(r *http.Request, create bool) (string, error) {
	key, workspace := workspaceParams(r)
	return h.storage.WorkspaceRoot(key, workspace, create)
}

func listDir(root string) ([]FileEntry, error) {
	entries := make([]FileEntry, 0)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return storageErr("unsafe_path", "symbolic links are not allowed")
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		entries = append(entries, FileEntry{Name: info.Name(), Path: filepath.ToSlash(rel), Dir: d.IsDir(), Size: info.Size(), MtimeMs: info.ModTime().UnixMilli()})
		return nil
	})
	return entries, err
}

func (h *Handler) listFiles(w http.ResponseWriter, r *http.Request) {
	root, err := h.workspaceRoot(r, false)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	entries, err := listDir(root)
	if errors.Is(err, os.ErrNotExist) {
		entries = []FileEntry{}
		err = nil
	}
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"files": entries})
}

func (h *Handler) uploadFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeError(w, 400, "invalid_request", "invalid multipart upload")
		return
	}
	key, workspace := r.FormValue("projectKey"), r.FormValue("workspacePath")
	root, err := h.storage.WorkspaceRoot(key, workspace, true)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, "invalid_request", "missing form file \"file\"")
		return
	}
	defer file.Close()
	targetPath := strings.TrimSpace(r.FormValue("path"))
	if targetPath == "" {
		targetPath = header.Filename
	}
	dest, err := safeTarget(root, targetPath, true)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if err := ensureSafeParents(root, filepath.Dir(dest)); err != nil {
		writeStorageError(w, err)
		return
	}
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	_, copyErr := io.Copy(out, file)
	closeErr := out.Close()
	if copyErr != nil {
		writeStorageError(w, copyErr)
		return
	}
	if closeErr != nil {
		writeStorageError(w, closeErr)
		return
	}
	entries, err := listDir(root)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"files": entries})
}

func ensureSafeParents(root, parent string) error {
	rel, err := filepath.Rel(root, parent)
	if err != nil {
		return err
	}
	if _, err := validateRelativePath(rel, "parent path", true); err != nil {
		return err
	}
	current := root
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if part == "" || part == "." {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			if err := os.Mkdir(current, 0o755); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return storageErr("unsafe_path", "upload parent is not a safe directory")
		}
	}
	return nil
}

func (h *Handler) downloadFile(w http.ResponseWriter, r *http.Request) {
	root, err := h.workspaceRoot(r, false)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	target, err := safeTarget(root, r.URL.Query().Get("path"), false)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	info, err := os.Lstat(target)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if !info.Mode().IsRegular() {
		writeError(w, 400, "unsafe_path", "path is not a regular file")
		return
	}
	file, err := os.Open(target)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(target)))
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, filepath.Base(target), info.ModTime(), file)
}

func (h *Handler) deleteFile(w http.ResponseWriter, r *http.Request) { h.remove(w, r, false, false) }
func (h *Handler) deleteFolder(w http.ResponseWriter, r *http.Request) {
	h.remove(w, r, true, r.URL.Query().Get("recursive") == "true")
}
func (h *Handler) remove(w http.ResponseWriter, r *http.Request, wantDir, recursive bool) {
	root, err := h.workspaceRoot(r, false)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	target, err := safeTarget(root, r.URL.Query().Get("path"), false)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	info, err := os.Lstat(target)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if info.IsDir() != wantDir || info.Mode()&os.ModeSymlink != 0 {
		writeError(w, 400, "unsafe_path", "target type is not allowed")
		return
	}
	if recursive {
		err = os.RemoveAll(target)
	} else {
		err = os.Remove(target)
	}
	if err != nil {
		writeStorageError(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *Handler) createFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ProjectKey    string `json:"projectKey"`
		WorkspacePath string `json:"workspacePath"`
		Path          string `json:"path"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		writeError(w, 400, "invalid_request", "invalid JSON body")
		return
	}
	root, err := h.storage.WorkspaceRoot(body.ProjectKey, body.WorkspacePath, true)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	target, err := safeTarget(root, body.Path, true)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if err := ensureSafeParents(root, target); err != nil {
		writeStorageError(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *Handler) ensureDir(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ProjectKey    string `json:"projectKey"`
		WorkspacePath string `json:"workspacePath"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		writeError(w, 400, "invalid_request", "invalid JSON body")
		return
	}
	root, err := h.storage.WorkspaceRoot(body.ProjectKey, body.WorkspacePath, true)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "path": root})
}

func writeStorageError(w http.ResponseWriter, err error) {
	code, status := "storage_unavailable", 500
	var typed *StorageError
	if errors.As(err, &typed) {
		code = typed.Code
		if code == "invalid_binding" || code == "unsafe_path" {
			status = 400
		} else if code == "missing_binding" {
			status = 404
		}
	}
	if errors.Is(err, os.ErrNotExist) {
		code, status = "not_found", 404
	}
	writeError(w, status, code, err.Error())
}
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "error": message})
}
