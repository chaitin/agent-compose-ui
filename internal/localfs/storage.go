package localfs

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var projectKeyPattern = regexp.MustCompile(`^ws_[0-9a-f]{32}$`)

type Binding struct {
	ProjectKey    string `json:"projectKey"`
	SourcePath    string `json:"sourcePath"`
	WorkspacePath string `json:"workspacePath"`
}

type StorageError struct {
	Code string
	Err  error
}

func (e *StorageError) Error() string { return e.Err.Error() }
func (e *StorageError) Unwrap() error { return e.Err }

type Storage struct {
	root       string
	legacyRoot string
}

func NewStorage(root, legacyRoot string) *Storage {
	if legacyRoot != "" {
		legacyRoot = filepath.Clean(legacyRoot)
	}
	return &Storage{root: filepath.Clean(root), legacyRoot: legacyRoot}
}

func storageErr(code, format string, args ...any) error {
	return &StorageError{Code: code, Err: fmt.Errorf(format, args...)}
}

func newProjectKey() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return "ws_" + hex.EncodeToString(value), nil
}

func (s *Storage) CreateBinding(ensureWorkspace bool) (Binding, error) {
	if err := os.MkdirAll(s.root, 0o755); err != nil {
		return Binding{}, storageErr("storage_unavailable", "create project storage root: %v", err)
	}
	for attempts := 0; attempts < 8; attempts++ {
		key, err := newProjectKey()
		if err != nil {
			return Binding{}, storageErr("storage_unavailable", "generate project key: %v", err)
		}
		projectDir := filepath.Join(s.root, key)
		if err := os.Mkdir(projectDir, 0o755); errors.Is(err, os.ErrExist) {
			continue
		} else if err != nil {
			return Binding{}, storageErr("storage_not_writable", "create project directory: %v", err)
		}
		binding := s.binding(key)
		if ensureWorkspace {
			if _, err := s.WorkspaceRoot(key, binding.WorkspacePath, true); err != nil {
				return Binding{}, err
			}
		}
		return binding, nil
	}
	return Binding{}, storageErr("storage_unavailable", "could not allocate unique project key")
}

func (s *Storage) binding(key string) Binding {
	return Binding{ProjectKey: key, SourcePath: filepath.Join(s.root, key, "agent-compose.yml"), WorkspacePath: "workspace"}
}

func (s *Storage) ResolveBinding(key string, ensureWorkspace bool) (Binding, error) {
	if !projectKeyPattern.MatchString(key) {
		return Binding{}, storageErr("invalid_binding", "invalid project key")
	}
	projectDir := filepath.Join(s.root, key)
	info, err := os.Lstat(projectDir)
	if errors.Is(err, os.ErrNotExist) {
		return Binding{}, storageErr("missing_binding", "project storage binding does not exist")
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Binding{}, storageErr("unsafe_path", "project binding is not a safe directory")
	}
	binding := s.binding(key)
	if ensureWorkspace {
		if _, err := s.WorkspaceRoot(key, binding.WorkspacePath, true); err != nil {
			return Binding{}, err
		}
	}
	return binding, nil
}

func (s *Storage) ResolveSourcePath(sourcePath string) (Binding, error) {
	clean := filepath.Clean(strings.TrimSpace(sourcePath))
	rel, err := filepath.Rel(s.root, clean)
	if err != nil {
		return Binding{}, storageErr("invalid_binding", "invalid source path")
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) != 2 || parts[1] != "agent-compose.yml" || !projectKeyPattern.MatchString(parts[0]) {
		return Binding{}, storageErr("invalid_binding", "source path is not managed by project storage")
	}
	binding, err := s.ResolveBinding(parts[0], false)
	if err != nil {
		return Binding{}, err
	}
	if binding.SourcePath != clean {
		return Binding{}, storageErr("invalid_binding", "source path is not canonical")
	}
	return binding, nil
}

func validateRelativePath(value, label string, allowDot bool) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || filepath.IsAbs(value) {
		return "", storageErr("unsafe_path", "%s must be relative", label)
	}
	clean := filepath.Clean(filepath.FromSlash(value))
	if (!allowDot && clean == ".") || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", storageErr("unsafe_path", "%s escapes project storage", label)
	}
	for _, part := range strings.Split(filepath.ToSlash(value), "/") {
		if part == ".." {
			return "", storageErr("unsafe_path", "%s contains traversal", label)
		}
	}
	return clean, nil
}

func rejectSymlinks(root, relative string) error {
	current := root
	for _, part := range strings.Split(filepath.ToSlash(relative), "/") {
		if part == "" || part == "." {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return storageErr("unsafe_path", "inspect path: %v", err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return storageErr("unsafe_path", "symbolic links are not allowed")
		}
	}
	return nil
}

func (s *Storage) WorkspaceRoot(key, workspacePath string, create bool) (string, error) {
	if _, err := s.ResolveBinding(key, false); err != nil {
		return "", err
	}
	clean, err := validateRelativePath(workspacePath, "workspace path", false)
	if err != nil {
		return "", err
	}
	projectDir := filepath.Join(s.root, key)
	if err := rejectSymlinks(projectDir, clean); err != nil {
		return "", err
	}
	root := filepath.Join(projectDir, clean)
	rel, err := filepath.Rel(projectDir, root)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", storageErr("unsafe_path", "workspace path escapes project")
	}
	if create {
		if err := os.MkdirAll(root, 0o755); err != nil {
			return "", storageErr("storage_not_writable", "create workspace: %v", err)
		}
		if err := rejectSymlinks(projectDir, clean); err != nil {
			return "", err
		}
	}
	return root, nil
}

func safeTarget(root, relative string, allowMissing bool) (string, error) {
	clean, err := validateRelativePath(relative, "file path", false)
	if err != nil {
		return "", err
	}
	if err := rejectSymlinks(root, clean); err != nil {
		return "", err
	}
	target := filepath.Join(root, clean)
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", storageErr("unsafe_path", "file path escapes workspace")
	}
	if !allowMissing {
		if _, err := os.Lstat(target); err != nil {
			return "", err
		}
	}
	return target, nil
}

func (s *Storage) MigrateLegacy(legacyKey, workspacePath string) (Binding, error) {
	if s.legacyRoot == "" {
		return Binding{}, storageErr("legacy_source_unavailable", "legacy project storage is not configured")
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(legacyKey) {
		return Binding{}, storageErr("unsafe_path", "invalid legacy project identifier")
	}
	workspace, err := validateRelativePath(workspacePath, "workspace path", false)
	if err != nil {
		return Binding{}, err
	}
	legacyProject := filepath.Join(s.legacyRoot, legacyKey)
	if err := rejectSymlinks(s.legacyRoot, filepath.Join(legacyKey, workspace)); err != nil {
		return Binding{}, err
	}
	source := filepath.Join(legacyProject, workspace)
	info, err := os.Lstat(source)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Binding{}, storageErr("legacy_source_unavailable", "legacy workspace is unavailable")
	}
	if err := os.MkdirAll(s.root, 0o755); err != nil {
		return Binding{}, storageErr("storage_unavailable", "create storage root: %v", err)
	}
	stage, err := os.MkdirTemp(s.root, ".migrate-")
	if err != nil {
		return Binding{}, storageErr("storage_not_writable", "create migration stage: %v", err)
	}
	defer os.RemoveAll(stage)
	if err := copyRegularTree(source, filepath.Join(stage, "workspace")); err != nil {
		return Binding{}, err
	}
	for attempts := 0; attempts < 8; attempts++ {
		key, err := newProjectKey()
		if err != nil {
			return Binding{}, err
		}
		final := filepath.Join(s.root, key)
		if err := os.Rename(stage, final); errors.Is(err, os.ErrExist) {
			continue
		} else if err != nil {
			return Binding{}, storageErr("storage_not_writable", "publish migrated workspace: %v", err)
		}
		stage = ""
		return s.binding(key), nil
	}
	return Binding{}, storageErr("storage_unavailable", "could not allocate migration binding")
}

func copyRegularTree(source, destination string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return storageErr("unsafe_path", "legacy workspace contains a symbolic link")
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return storageErr("unsafe_path", "legacy workspace contains a non-regular file")
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		defer input.Close()
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(output, input)
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}
