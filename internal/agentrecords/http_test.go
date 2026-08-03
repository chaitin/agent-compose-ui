package agentrecords

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestListsAllowedJSONLFilesFromPartitionedSandbox(t *testing.T) {
	root := t.TempDir()
	sandboxID := "sandbox-12345678"
	sandbox := filepath.Join(root, "2026", "07", "28", sandboxID)
	writeTestFile(t, filepath.Join(sandbox, "home", ".codex", "sessions", "2026", "run.jsonl"), "{\"type\":\"event\"}\n")
	writeTestFile(t, filepath.Join(sandbox, "home", ".claude", "projects", "workspace", "session.jsonl"), "{}\n")
	writeTestFile(t, filepath.Join(sandbox, "home", ".codex", "config.toml"), "secret")

	response := httptest.NewRecorder()
	New(root).ServeHTTP(response, request(sandboxID, ""))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Items []Record `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 2 || body.Items[0].Provider == body.Items[1].Provider {
		t.Fatalf("items = %#v", body.Items)
	}
	for _, item := range body.Items {
		if strings.Contains(item.Path, sandbox) || !strings.HasSuffix(item.Path, ".jsonl") {
			t.Fatalf("unsafe path = %q", item.Path)
		}
	}
}

func TestReadsRecordInReverseChunksWithoutChangingBytes(t *testing.T) {
	root := t.TempDir()
	sandboxID := "sandbox-12345678"
	relative := "home/.codex/sessions/run.jsonl"
	content := "第一行\nsecond line\nthird line\n"
	writeTestFile(t, filepath.Join(root, sandboxID, filepath.FromSlash(relative)), content)
	recordID := base64.RawURLEncoding.EncodeToString([]byte(relative))

	latest := httptest.NewRecorder()
	New(root).ServeHTTP(latest, request(sandboxID, recordID+"?limit=12"))
	var second chunkResponse
	if err := json.Unmarshal(latest.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if !second.HasEarlier || second.End != int64(len([]byte(content))) {
		t.Fatalf("latest = %#v", second)
	}

	earlier := httptest.NewRecorder()
	New(root).ServeHTTP(earlier, request(sandboxID, recordID+"?limit=1048576&before="+strconv.FormatInt(second.Start, 10)))
	var first chunkResponse
	if err := json.Unmarshal(earlier.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if first.Content+second.Content != content || first.HasEarlier {
		t.Fatalf("combined = %q + %q", first.Content, second.Content)
	}
}

func TestRejectsFilesOutsideProviderRootsAndSymlinks(t *testing.T) {
	root := t.TempDir()
	sandboxID := "sandbox-12345678"
	sandbox := filepath.Join(root, sandboxID)
	outside := filepath.Join(root, "outside.jsonl")
	writeTestFile(t, outside, "secret")
	symlink := filepath.Join(sandbox, "home", ".codex", "sessions", "linked.jsonl")
	if err := os.MkdirAll(filepath.Dir(symlink), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, symlink); err != nil {
		t.Fatal(err)
	}

	for _, relative := range []string{"../../outside.jsonl", "home/.codex/config.jsonl", "home/.codex/sessions/linked.jsonl"} {
		id := base64.RawURLEncoding.EncodeToString([]byte(relative))
		response := httptest.NewRecorder()
		New(root).ServeHTTP(response, request(sandboxID, id))
		if response.Code != http.StatusNotFound {
			t.Fatalf("relative %q status = %d", relative, response.Code)
		}
	}
}

func TestRejectsInvalidPaginationAndSandboxID(t *testing.T) {
	root := t.TempDir()
	sandboxID := "sandbox-12345678"
	writeTestFile(t, filepath.Join(root, sandboxID, "home", ".claude", "projects", "run.jsonl"), "{}\n")
	id := base64.RawURLEncoding.EncodeToString([]byte("home/.claude/projects/run.jsonl"))

	invalidChunk := httptest.NewRecorder()
	New(root).ServeHTTP(invalidChunk, request(sandboxID, id+"?limit=1048577"))
	if invalidChunk.Code != http.StatusBadRequest {
		t.Fatalf("invalid chunk status = %d", invalidChunk.Code)
	}
	invalidID := httptest.NewRecorder()
	New(root).ServeHTTP(invalidID, httptest.NewRequest(http.MethodGet, "/api/ui/v1/sandboxes/../../etc/agent-records", nil))
	if invalidID.Code != http.StatusNotFound {
		t.Fatalf("invalid sandbox status = %d", invalidID.Code)
	}
}

func request(sandboxID, suffix string) *http.Request {
	path := "/api/ui/v1/sandboxes/" + sandboxID + "/agent-records"
	if suffix != "" {
		path += "/" + suffix
	}
	return httptest.NewRequest(http.MethodGet, path, nil)
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
