package localfs

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func createTestBinding(t *testing.T, handler *Handler) Binding {
	t.Helper()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/project-storage/bind", bytes.NewBufferString(`{"ensureWorkspace":true}`)))
	if response.Code != http.StatusOK {
		t.Fatalf("bind status=%d body=%s", response.Code, response.Body.String())
	}
	var binding Binding
	if err := json.NewDecoder(response.Body).Decode(&binding); err != nil {
		t.Fatal(err)
	}
	return binding
}

func TestHandlerBindsAndResolvesCanonicalSource(t *testing.T) {
	handler := New(NewStorage(t.TempDir(), ""))
	binding := createTestBinding(t, handler)
	body, _ := json.Marshal(map[string]string{"sourcePath": binding.SourcePath})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/project-storage/resolve", bytes.NewReader(body)))
	if response.Code != http.StatusOK {
		t.Fatalf("resolve status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestHandlerUploadUsesProjectKeyAndPreservesNestedPath(t *testing.T) {
	root := t.TempDir()
	handler := New(NewStorage(root, ""))
	binding := createTestBinding(t, handler)
	var requestBody bytes.Buffer
	writer := multipart.NewWriter(&requestBody)
	_ = writer.WriteField("projectKey", binding.ProjectKey)
	_ = writer.WriteField("workspacePath", "workspace")
	_ = writer.WriteField("path", "nested/readme.txt")
	part, err := writer.CreateFormFile("file", "readme.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("shared"))
	_ = writer.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/local-workspace/upload", &requestBody)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("upload status=%d body=%s", response.Code, response.Body.String())
	}
	content, err := os.ReadFile(filepath.Join(root, binding.ProjectKey, "workspace", "nested", "readme.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "shared" {
		t.Fatalf("content=%q", content)
	}
}

func TestHandlerRejectsCrossProjectTraversal(t *testing.T) {
	handler := New(NewStorage(t.TempDir(), ""))
	binding := createTestBinding(t, handler)
	response := httptest.NewRecorder()
	url := "/api/local-workspace/files?projectKey=" + binding.ProjectKey + "&workspacePath=../other/workspace"
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, url, nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
