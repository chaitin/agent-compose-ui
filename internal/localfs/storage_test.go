package localfs

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestStorageCreatesAndResolvesCanonicalBinding(t *testing.T) {
	storage := NewStorage(t.TempDir(), "")
	binding, err := storage.CreateBinding(false)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^ws_[0-9a-f]{32}$`).MatchString(binding.ProjectKey) {
		t.Fatalf("project key = %q", binding.ProjectKey)
	}
	want := filepath.Join(storage.root, binding.ProjectKey, "agent-compose.yml")
	if binding.SourcePath != want {
		t.Fatalf("source path = %q, want %q", binding.SourcePath, want)
	}
	resolved, err := storage.ResolveSourcePath(binding.SourcePath)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.ProjectKey != binding.ProjectKey {
		t.Fatalf("resolved = %#v", resolved)
	}
}

func TestStorageRejectsUnmanagedSourceAndWorkspaceTraversal(t *testing.T) {
	storage := NewStorage(t.TempDir(), "")
	if _, err := storage.ResolveSourcePath("/tmp/other/agent-compose.yml"); err == nil {
		t.Fatal("accepted unmanaged source path")
	}
	binding, err := storage.CreateBinding(false)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"", "../outside", "/absolute", "a/../../b"} {
		if _, err := storage.WorkspaceRoot(binding.ProjectKey, path, false); err == nil {
			t.Fatalf("accepted workspace path %q", path)
		}
	}
}

func TestStorageRejectsWorkspaceSymlink(t *testing.T) {
	storage := NewStorage(t.TempDir(), "")
	binding, err := storage.CreateBinding(false)
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(storage.root, binding.ProjectKey, "workspace")); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.WorkspaceRoot(binding.ProjectKey, "workspace", false); err == nil {
		t.Fatal("accepted symlink workspace")
	}
}
