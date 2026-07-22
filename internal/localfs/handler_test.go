package localfs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveRootFromLogicalComposePath(t *testing.T) {
	projectDir := t.TempDir()
	want := filepath.Join(projectDir, "workspace")

	got, err := resolveRoot(filepath.Join(projectDir, "agent-compose.yml"), "workspace")
	if err != nil {
		t.Fatalf("resolveRoot: %v", err)
	}
	if got != want {
		t.Fatalf("resolveRoot = %q, want %q", got, want)
	}
}

func TestResolveRootFromExistingComposeFile(t *testing.T) {
	projectDir := t.TempDir()
	composePath := filepath.Join(projectDir, "agent-compose.yaml")
	if err := os.WriteFile(composePath, []byte("name: test\n"), 0o600); err != nil {
		t.Fatalf("write compose file: %v", err)
	}

	got, err := resolveRoot(composePath, "workspace")
	if err != nil {
		t.Fatalf("resolveRoot: %v", err)
	}
	want := filepath.Join(projectDir, "workspace")
	if got != want {
		t.Fatalf("resolveRoot = %q, want %q", got, want)
	}
}

func TestResolveRootRejectsEscape(t *testing.T) {
	_, err := resolveRoot(filepath.Join(t.TempDir(), "agent-compose.yml"), "../outside")
	if err == nil {
		t.Fatal("resolveRoot accepted escaping workspace path")
	}
}
