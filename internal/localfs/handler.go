package localfs

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type FileEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Dir     bool   `json:"dir"`
	Size    int64  `json:"size"`
	MtimeMs int64  `json:"mtimeMs"`
}

const maxUploadBytes = 256 << 20 // 256 MiB

type Handler struct{}

func New() *Handler {
	return &Handler{}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == "/api/local-workspace/files" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		h.listFiles(w, r)
	case path == "/api/local-workspace/upload" && r.Method == http.MethodPost:
		h.uploadFile(w, r)
	case path == "/api/local-workspace/download" && r.Method == http.MethodGet:
		h.downloadFile(w, r)
	case path == "/api/local-workspace/file" && r.Method == http.MethodDelete:
		h.deleteFile(w, r)
	case path == "/api/local-workspace/folder" && r.Method == http.MethodPost:
		h.createFolder(w, r)
	case path == "/api/local-workspace/folder" && r.Method == http.MethodDelete:
		h.deleteFolder(w, r)
	case path == "/api/local-workspace/ensure-dir" && r.Method == http.MethodPost:
		h.ensureDir(w, r)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func resolveRoot(sourcePath, workspacePath string) (string, error) {
	sourcePath = strings.TrimSpace(sourcePath)
	if sourcePath == "" {
		return "", fmt.Errorf("sourcePath is required")
	}
	if !filepath.IsAbs(sourcePath) {
		return "", fmt.Errorf("sourcePath must be absolute")
	}
	workspacePath = strings.TrimSpace(workspacePath)
	if workspacePath == "" {
		return "", fmt.Errorf("workspacePath is required")
	}
	if filepath.IsAbs(workspacePath) {
		return "", fmt.Errorf("workspacePath must be relative")
	}
	clean := filepath.Clean(workspacePath)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("workspacePath must not escape source root")
	}
	// Resolve sourcePath to handle YAML file case (strip filename if it's a file)
	sourceAbs, err := filepath.Abs(sourcePath)
	if err != nil {
		return "", fmt.Errorf("resolve sourcePath: %w", err)
	}
	info, err := os.Stat(sourceAbs)
	if err == nil {
		if !info.IsDir() {
			sourceAbs = filepath.Dir(sourceAbs)
		}
	} else if os.IsNotExist(err) {
		// API-created projects retain a logical compose path even when the YAML
		// is not materialized on the gateway filesystem.
		ext := strings.ToLower(filepath.Ext(sourceAbs))
		if ext == ".yml" || ext == ".yaml" {
			sourceAbs = filepath.Dir(sourceAbs)
		}
	} else {
		return "", fmt.Errorf("inspect sourcePath: %w", err)
	}
	root := filepath.Join(sourceAbs, clean)
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve workspace root: %w", err)
	}
	// Safety: ensure resolved path is within sourceDir.
	rel, err := filepath.Rel(sourceAbs, rootAbs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("workspace path escapes source root")
	}
	return rootAbs, nil
}

func (h *Handler) listFiles(w http.ResponseWriter, r *http.Request) {
	sourcePath := r.URL.Query().Get("sourcePath")
	workspacePath := r.URL.Query().Get("workspacePath")
	root, err := resolveRoot(sourcePath, workspacePath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	entries, err := listDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusOK, map[string]interface{}{"files": []FileEntry{}})
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"files": entries})
}

func listDir(root string) ([]FileEntry, error) {
	root = filepath.Clean(root)
	entries := make([]FileEntry, 0)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		entries = append(entries, FileEntry{
			Name:    info.Name(),
			Path:    filepath.ToSlash(rel),
			Dir:     d.IsDir(),
			Size:    info.Size(),
			MtimeMs: info.ModTime().UnixMilli(),
		})
		if d.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}

func (h *Handler) uploadFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	sourcePath := r.FormValue("sourcePath")
	workspacePath := r.FormValue("workspacePath")
	targetPath := strings.TrimSpace(r.FormValue("path"))
	root, err := resolveRoot(sourcePath, workspacePath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	file, fileHeader, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing form file \"file\"")
		return
	}
	defer func() { _ = file.Close() }()

	fileName := fileHeader.Filename
	if targetPath != "" {
		targetPath = filepath.ToSlash(filepath.Clean(targetPath))
		if filepath.IsAbs(targetPath) || strings.HasPrefix(targetPath, "..") {
			writeError(w, http.StatusBadRequest, "invalid target path")
			return
		}
	}
	if targetPath == "" && fileName != "" {
		targetPath = filepath.ToSlash(filepath.Clean(fileName))
	}
	if targetPath == "" || targetPath == "." {
		writeError(w, http.StatusBadRequest, "could not determine target path")
		return
	}

	dest := filepath.Join(root, filepath.FromSlash(targetPath))
	destAbs, err := filepath.Abs(dest)
	if err != nil || !strings.HasPrefix(destAbs, root) {
		writeError(w, http.StatusBadRequest, "target path escapes workspace root")
		return
	}

	if err := os.MkdirAll(filepath.Dir(destAbs), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("create parent directory: %v", err))
		return
	}
	out, err := os.OpenFile(destAbs, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("create file: %v", err))
		return
	}
	defer func() { _ = out.Close() }()
	if _, err := io.Copy(out, file); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("write file: %v", err))
		return
	}
	if err := out.Close(); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("close file: %v", err))
		return
	}

	entries, err := listDir(root)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"files": entries})
}

func (h *Handler) downloadFile(w http.ResponseWriter, r *http.Request) {
	sourcePath := r.URL.Query().Get("sourcePath")
	workspacePath := r.URL.Query().Get("workspacePath")
	relPath := r.URL.Query().Get("path")
	root, err := resolveRoot(sourcePath, workspacePath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if relPath == "" || strings.Contains(relPath, "..") || filepath.IsAbs(relPath) {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}
	target := filepath.Join(root, filepath.FromSlash(filepath.Clean(relPath)))
	targetAbs, err := filepath.Abs(target)
	if err != nil || !strings.HasPrefix(targetAbs, root) {
		writeError(w, http.StatusBadRequest, "path escapes workspace root")
		return
	}
	info, err := os.Stat(targetAbs)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "file not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is a directory")
		return
	}
	file, err := os.Open(targetAbs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer func() { _ = file.Close() }()
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(targetAbs)))
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, filepath.Base(targetAbs), info.ModTime(), file)
}

func (h *Handler) deleteFile(w http.ResponseWriter, r *http.Request) {
	sourcePath := r.URL.Query().Get("sourcePath")
	workspacePath := r.URL.Query().Get("workspacePath")
	relPath := r.URL.Query().Get("path")
	root, err := resolveRoot(sourcePath, workspacePath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if relPath == "" || strings.Contains(relPath, "..") || filepath.IsAbs(relPath) {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}
	target := filepath.Join(root, filepath.FromSlash(filepath.Clean(relPath)))
	targetAbs, err := filepath.Abs(target)
	if err != nil || !strings.HasPrefix(targetAbs, root) {
		writeError(w, http.StatusBadRequest, "path escapes workspace root")
		return
	}
	if err := os.Remove(targetAbs); err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "file not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) createFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SourcePath    string `json:"sourcePath"`
		WorkspacePath string `json:"workspacePath"`
		Path          string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	root, err := resolveRoot(body.SourcePath, body.WorkspacePath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	relPath := strings.TrimSpace(body.Path)
	if relPath == "" || strings.Contains(relPath, "..") || filepath.IsAbs(relPath) {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}
	target := filepath.Join(root, filepath.FromSlash(filepath.Clean(relPath)))
	targetAbs, err := filepath.Abs(target)
	if err != nil || !strings.HasPrefix(targetAbs, root) {
		writeError(w, http.StatusBadRequest, "path escapes workspace root")
		return
	}
	if err := os.MkdirAll(targetAbs, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) deleteFolder(w http.ResponseWriter, r *http.Request) {
	sourcePath := r.URL.Query().Get("sourcePath")
	workspacePath := r.URL.Query().Get("workspacePath")
	relPath := r.URL.Query().Get("path")
	recursive := r.URL.Query().Get("recursive") == "true"
	root, err := resolveRoot(sourcePath, workspacePath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if relPath == "" || strings.Contains(relPath, "..") || filepath.IsAbs(relPath) {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}
	target := filepath.Join(root, filepath.FromSlash(filepath.Clean(relPath)))
	targetAbs, err := filepath.Abs(target)
	if err != nil || !strings.HasPrefix(targetAbs, root) {
		writeError(w, http.StatusBadRequest, "path escapes workspace root")
		return
	}
	if recursive {
		if err := os.RemoveAll(targetAbs); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else {
		if err := os.Remove(targetAbs); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) ensureDir(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SourcePath    string `json:"sourcePath"`
		WorkspacePath string `json:"workspacePath"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	root, err := resolveRoot(body.SourcePath, body.WorkspacePath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("create workspace directory: %v", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "path": root})
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
