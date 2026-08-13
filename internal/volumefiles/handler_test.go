package volumefiles

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDaemonInspectorUsesImmutableConnectContract(t *testing.T) {
	var called bool
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.URL.Path != "/agentcompose.v2.VolumeService/InspectVolume" || r.Method != http.MethodPost {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"name":"cache"}`+"\n" {
			t.Errorf("body = %q", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"volume": map[string]any{"name": "cache", "driver": "local", "path": "/volumes/cache", "projectId": "p", "labels": map[string]string{"k": "v"}}})
	}))
	defer daemon.Close()
	base, _ := url.Parse(daemon.URL)
	v, err := NewDaemonInspector(base, daemon.Client()).InspectVolume(context.Background(), "cache")
	if err != nil || !called || v.Path != "/volumes/cache" || v.Labels["k"] != "v" {
		t.Fatalf("InspectVolume = %#v, %v", v, err)
	}
}

func multipartRequest(t *testing.T, fields [][2]string, fileName string, data []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for _, f := range fields {
		p, err := mw.CreateFormField(f[0])
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(p, f[1])
	}
	if fileName != "" {
		p, err := mw.CreateFormFile("file", fileName)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = p.Write(data)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/volume-files/upload", &body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	return r
}

func TestHandlerMultipartStrictnessAndFilenameIgnored(t *testing.T) {
	root := t.TempDir()
	resolver := &Resolver{Root: filepath.Dir(root), Inspector: inspectorFunc(func(context.Context, string) (Volume, error) {
		return Volume{Name: "cache", Driver: "local", Path: root, Labels: map[string]string{"agent-compose-ui.managed": "true", "agent-compose-ui.project-key": validProject}}, nil
	})}
	h := NewHandler(&Storage{}, resolver)
	good := [][2]string{{"path", "saved.bin"}, {"volume", "cache"}, {"projectKey", validProject}}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, multipartRequest(t, good, "../../ignored", []byte{0, 1, 2}))
	if rec.Code != 201 {
		t.Fatalf("good = %d %s", rec.Code, rec.Body.String())
	}
	var uploaded struct {
		File Entry `json:"file"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &uploaded); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	if uploaded.File.Name != "saved.bin" || uploaded.File.Path != "saved.bin" || uploaded.File.Dir {
		t.Fatalf("upload response file = %#v", uploaded.File)
	}
	if b, err := os.ReadFile(filepath.Join(root, "saved.bin")); err != nil || !bytes.Equal(b, []byte{0, 1, 2}) {
		t.Fatalf("saved = %v %v", b, err)
	}
	tests := []struct {
		name   string
		fields [][2]string
		file   string
		data   []byte
		want   int
	}{
		{"missing", good[:2], "x", nil, 400}, {"duplicate", append(good, [2]string{"path", "again"}), "x", nil, 400}, {"unknown", append(good, [2]string{"wat", "x"}), "x", nil, 400}, {"invalid-utf8", [][2]string{{"projectKey", string([]byte{0xff})}, {"volume", "cache"}, {"path", "x"}}, "x", nil, 400}, {"metadata-overflow", [][2]string{{"projectKey", validProject}, {"volume", "cache"}, {"path", strings.Repeat("x", MaxRelativePathBytes+1)}}, "x", nil, 413}, {"file-overflow", good, "x", make([]byte, defaultMaxFileBytes+1), 413},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, multipartRequest(t, tc.fields, tc.file, tc.data))
			if rec.Code != tc.want {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestDaemonInspectorCancellationAndMissingVolume(t *testing.T) {
	t.Run("cancel", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
		defer srv.Close()
		u, _ := url.Parse(srv.URL)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := NewDaemonInspector(u, srv.Client()).InspectVolume(ctx, "cache")
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("missing", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{}`) }))
		defer srv.Close()
		u, _ := url.Parse(srv.URL)
		_, err := NewDaemonInspector(u, srv.Client()).InspectVolume(context.Background(), "cache")
		if !errors.Is(err, ErrUpstream) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestDaemonInspectorRejectsNonJSONSuccessAndRedirects(t *testing.T) {
	for _, ct := range []string{"", "text/html", "application/problem+json"} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if ct != "" {
				w.Header().Set("Content-Type", ct)
			}
			_, _ = io.WriteString(w, `{"volume":{"name":"cache"}}`)
		}))
		u, _ := url.Parse(srv.URL)
		_, err := NewDaemonInspector(u, srv.Client()).InspectVolume(context.Background(), "cache")
		srv.Close()
		if !errors.Is(err, ErrUpstream) {
			t.Errorf("Content-Type %q error=%v", ct, err)
		}
	}
	hits := 0
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer attacker.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, attacker.URL, http.StatusFound) }))
	defer redirect.Close()
	u, _ := url.Parse(redirect.URL)
	_, err := NewDaemonInspector(u, redirect.Client()).InspectVolume(context.Background(), "cache")
	if !errors.Is(err, ErrUpstream) || hits != 0 {
		t.Fatalf("redirect error=%v hits=%d", err, hits)
	}
}

func TestDaemonInspectorRejectsUnsafeBaseURL(t *testing.T) {
	for _, raw := range []string{"ftp://example.test", "http://user:pass@example.test", "http://example.test/base?q=x", "http://example.test/base#x"} {
		u, _ := url.Parse(raw)
		_, err := NewDaemonInspector(u, nil).InspectVolume(context.Background(), "cache")
		if !errors.Is(err, ErrUnavailable) {
			t.Errorf("base %q error=%v", raw, err)
		}
	}
}

type deadlineBody struct {
	io.Reader
	values []time.Time
}

type timeoutBody struct{ values []time.Time }

func (b *timeoutBody) Read([]byte) (int, error)          { return 0, timeoutReadError{} }
func (b *timeoutBody) Close() error                      { return nil }
func (b *timeoutBody) SetReadDeadline(v time.Time) error { b.values = append(b.values, v); return nil }

type timeoutReadError struct{}

func (timeoutReadError) Error() string   { return "read timeout" }
func (timeoutReadError) Timeout() bool   { return true }
func (timeoutReadError) Temporary() bool { return true }

func (b *deadlineBody) Close() error                      { return nil }
func (b *deadlineBody) SetReadDeadline(v time.Time) error { b.values = append(b.values, v); return nil }

func TestHandlerScopesAndClearsBodyReadDeadline(t *testing.T) {
	b := &deadlineBody{Reader: strings.NewReader(`{}`)}
	r := httptest.NewRequest(http.MethodPut, "/api/volume-files/file", nil)
	r.Body = b
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	NewHandler(nil, nil).ServeHTTP(rec, r)
	if len(b.values) != 2 || b.values[0].IsZero() || !b.values[1].IsZero() {
		t.Fatalf("deadlines = %#v", b.values)
	}
}

func TestHandlerMapsBodyReadTimeoutAndClearsDeadline(t *testing.T) {
	b := &timeoutBody{}
	r := httptest.NewRequest(http.MethodPut, "/api/volume-files/file", nil)
	r.Body = b
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	NewHandler(nil, nil).ServeHTTP(rec, r)
	if rec.Code != http.StatusRequestTimeout {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(b.values) != 2 || !b.values[1].IsZero() {
		t.Fatalf("deadlines=%#v", b.values)
	}
}

func TestHandlerEncodedPathsAreParsedOnce(t *testing.T) {
	root := t.TempDir()
	literal := "%2e%2e"
	if err := os.WriteFile(filepath.Join(root, literal), []byte("literal"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolver := &Resolver{Root: filepath.Dir(root), Inspector: inspectorFunc(func(context.Context, string) (Volume, error) {
		return Volume{Name: "cache", Driver: "local", Path: root, Labels: map[string]string{"agent-compose-ui.managed": "true", "agent-compose-ui.project-key": validProject}}, nil
	})}
	h := NewHandler(&Storage{}, resolver)
	for _, tc := range []struct {
		raw    string
		status int
	}{{"%2e%2e", 400}, {"%252e%252e", 200}, {"%2Fetc", 400}, {"a%5Cb", 400}, {"a%00b", 400}} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/volume-files/preview?projectKey="+validProject+"&volume=cache&path="+tc.raw, nil))
		if rec.Code != tc.status {
			t.Errorf("path %s = %d: %s", tc.raw, rec.Code, rec.Body.String())
		}
	}
}

func TestHandlerDeleteEndpointsEnforceObjectType(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	resolver := &Resolver{Root: filepath.Dir(root), Inspector: inspectorFunc(func(context.Context, string) (Volume, error) {
		return Volume{Name: "cache", Driver: "local", Path: root, Labels: map[string]string{"agent-compose-ui.managed": "true", "agent-compose-ui.project-key": validProject}}, nil
	})}
	h := NewHandler(&Storage{}, resolver)
	base := "?projectKey=" + validProject + "&volume=cache&path="
	for _, raw := range []string{"/api/volume-files/file" + base + "dir", "/api/volume-files/folder" + base + "file&recursive=false"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, raw, nil))
		if rec.Code != http.StatusConflict {
			t.Errorf("%s = %d %s", raw, rec.Code, rec.Body.String())
		}
	}
	if _, err := os.Stat(filepath.Join(root, "file")); err != nil {
		t.Fatal("file mutated")
	}
	if _, err := os.Stat(filepath.Join(root, "dir")); err != nil {
		t.Fatal("dir mutated")
	}
}

func TestHandlerJSONMediaTypeIsStrict(t *testing.T) {
	for _, ct := range []string{"", "text/plain", "application/json; charset=latin1", "application/problem+json"} {
		req := httptest.NewRequest(http.MethodPut, "/api/volume-files/file", strings.NewReader(`{}`))
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		rec := httptest.NewRecorder()
		NewHandler(nil, nil).ServeHTTP(rec, req)
		if rec.Code != http.StatusUnsupportedMediaType {
			t.Errorf("Content-Type %q = %d", ct, rec.Code)
		}
	}
	for _, ct := range []string{"application/json", "application/json; charset=utf-8", "application/json; charset=UTF-8"} {
		req := httptest.NewRequest(http.MethodPut, "/api/volume-files/file", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", ct)
		rec := httptest.NewRecorder()
		NewHandler(nil, nil).ServeHTTP(rec, req)
		if rec.Code == http.StatusUnsupportedMediaType {
			t.Errorf("Content-Type %q rejected", ct)
		}
	}
}

func TestHandlerMapsPartialDeleteWithoutPhysicalPath(t *testing.T) {
	rec := httptest.NewRecorder()
	storageAPIError(rec, fmt.Errorf("%w: /private/volume", ErrPartialMutation))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"partial_delete"`) || strings.Contains(rec.Body.String(), "/private") {
		t.Fatalf("response=%d %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerMapsPartialWriteDistinctly(t *testing.T) {
	rec := httptest.NewRecorder()
	storageAPIError(rec, fmt.Errorf("%w: /private/transaction", ErrPartialWrite))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"partial_mutation"`) || !strings.Contains(rec.Body.String(), "write may have partially completed") || strings.Contains(rec.Body.String(), "/private") {
		t.Fatalf("response=%d %s", rec.Code, rec.Body.String())
	}
}

func TestDaemonInspectorMapsFailuresSafely(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"not-found", 404, `{"code":"not_found"}`, ErrNotFound},
		{"upstream", 500, `{"message":"physical /secret"}`, ErrUnavailable},
		{"malformed", 200, `{`, ErrUpstream},
		{"oversize", 200, `{"volume":{"name":"` + strings.Repeat("x", 1<<20) + `"}}`, ErrUpstream},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer srv.Close()
			u, _ := url.Parse(srv.URL)
			_, err := NewDaemonInspector(u, srv.Client()).InspectVolume(context.Background(), "cache")
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestHandlerListPreviewDownloadAndStrictQuery(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolver := &Resolver{Root: filepath.Dir(root), Inspector: inspectorFunc(func(context.Context, string) (Volume, error) {
		return Volume{Name: "cache", Driver: "local", Path: root, Labels: map[string]string{"agent-compose-ui.managed": "true", "agent-compose-ui.project-key": validProject}}, nil
	})}
	h := NewHandler(&Storage{}, resolver)
	for _, raw := range []string{
		"/api/volume-files?projectKey=" + validProject + "&volume=cache",
		"/api/volume-files/preview?projectKey=" + validProject + "&volume=cache&path=hello.txt",
		"/api/volume-files/download?projectKey=" + validProject + "&volume=cache&path=hello.txt",
	} {
		req := httptest.NewRequest("GET", raw, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("%s = %d %s", raw, rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), root) {
			t.Fatal("physical path leaked")
		}
	}
	for _, raw := range []string{
		"/api/volume-files?projectKey=" + validProject + "&projectKey=x&volume=cache",
		"/api/volume-files?projectKey=" + validProject + "&volume=cache&unknown=x",
		"/api/volume-files/preview?projectKey=" + validProject + "&volume=cache",
		"/api/volume-files/?projectKey=" + validProject + "&volume=cache",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", raw, nil))
		if rec.Code != 400 && rec.Code != 404 {
			t.Fatalf("%s = %d", raw, rec.Code)
		}
	}
}

func TestHandlerWriteJSONRejectsDuplicates(t *testing.T) {
	h := NewHandler(&Storage{}, &Resolver{})
	body := `{"projectKey":"` + validProject + `","projectKey":"` + validProject + `","volume":"v","path":"a","content":"x"}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/volume-files/file", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerJSONTotalOverflowIs413(t *testing.T) {
	h := NewHandler(&Storage{}, &Resolver{})
	body := `{"projectKey":"` + validProject + `","volume":"v","path":"a","content":"` + strings.Repeat("x", int(defaultMaxFileBytes+(64<<10))) + `"}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/volume-files/file", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}
