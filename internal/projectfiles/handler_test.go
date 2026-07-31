package projectfiles

import (
	"bytes"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testProjectKey = "ws_0123456789abcdef0123456789abcdef"

func TestHandlerListEmptySkillsBeforeFirstCreate(t *testing.T) {
	h := NewHandler(&Storage{ProjectRoot: projectRoot(t), MaxFileBytes: 1024})

	listed := request(t, h, http.MethodGet, "/api/project-files/skills?projectKey="+testProjectKey, "", "")
	if listed.Code != http.StatusOK || listed.Body.String() != "{\"entries\":[]}\n" {
		t.Fatalf("list empty skills = %d %s", listed.Code, listed.Body.String())
	}
}

func TestHandlerCreateListReadWriteDeleteRoundTrip(t *testing.T) {
	root := projectRoot(t)
	h := NewHandler(&Storage{ProjectRoot: root, MaxFileBytes: 1024})
	created := request(t, h, http.MethodPost, "/api/project-files/skills/create", "application/json", `{"projectKey":"`+testProjectKey+`","name":"my_skill"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}

	read := request(t, h, http.MethodGet, "/api/project-files/file?projectKey="+testProjectKey+"&path=my_skill%2FSKILL.md", "", "")
	want := "---\nname: my_skill\ndescription: 请填写 Skill 的用途\n---\n\n请在这里编写 Skill 指令。\n"
	if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), jsonString(t, want)) {
		t.Fatalf("read = %d %s", read.Code, read.Body.String())
	}

	var doc struct {
		File struct {
			SHA256 string `json:"sha256"`
		} `json:"file"`
	}
	if err := json.Unmarshal(read.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	writeBody := `{"projectKey":"` + testProjectKey + `","path":"my_skill/SKILL.md","content":"changed","expectedSHA256":"` + doc.File.SHA256 + `"}`
	written := request(t, h, http.MethodPut, "/api/project-files/file", "application/json", writeBody)
	if written.Code != http.StatusOK {
		t.Fatalf("write = %d %s", written.Code, written.Body.String())
	}
	conflict := request(t, h, http.MethodPut, "/api/project-files/file", "application/json", writeBody)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflict = %d %s", conflict.Code, conflict.Body.String())
	}

	listed := request(t, h, http.MethodGet, "/api/project-files/skills?projectKey="+testProjectKey+"&path=my_skill", "", "")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), "SKILL.md") {
		t.Fatalf("list = %d %s", listed.Code, listed.Body.String())
	}
	deleted := request(t, h, http.MethodDelete, "/api/project-files/file?projectKey="+testProjectKey+"&path=my_skill%2FSKILL.md", "", "")
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete = %d %s", deleted.Code, deleted.Body.String())
	}
}

func TestHandlerValidationMethodsAndContentType(t *testing.T) {
	h := NewHandler(&Storage{ProjectRoot: projectRoot(t), MaxFileBytes: 8})
	badName := request(t, h, http.MethodPost, "/api/project-files/skills/create", "application/json", `{"projectKey":"`+testProjectKey+`","name":"Bad/Name"}`)
	if badName.Code != http.StatusBadRequest {
		t.Fatalf("bad name = %d", badName.Code)
	}
	wrongMethod := request(t, h, http.MethodPatch, "/api/project-files/file", "application/json", `{}`)
	if wrongMethod.Code != http.StatusMethodNotAllowed || wrongMethod.Header().Get("Allow") == "" {
		t.Fatalf("method = %d allow=%q", wrongMethod.Code, wrongMethod.Header().Get("Allow"))
	}
	media := request(t, h, http.MethodPut, "/api/project-files/file", "text/plain", `{}`)
	if media.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("media = %d", media.Code)
	}
	unknown := request(t, h, http.MethodPut, "/api/project-files/file", "application/json", `{"wat":1}`)
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("unknown = %d", unknown.Code)
	}
	wrongSHAField := request(t, h, http.MethodPut, "/api/project-files/file", "application/json", `{"projectKey":"`+testProjectKey+`","path":"x","content":"x","expectedSHA":"abc"}`)
	if wrongSHAField.Code != http.StatusBadRequest {
		t.Fatalf("expectedSHA alias = %d", wrongSHAField.Code)
	}
}

func TestHandlerChecksumSyntaxAndPostRenameUncertainty(t *testing.T) {
	root := projectRoot(t)
	h := NewHandler(&Storage{ProjectRoot: root})
	seed := `{"projectKey":"` + testProjectKey + `","path":"file","content":"before","expectedSHA256":""}`
	if got := request(t, h, http.MethodPut, "/api/project-files/file", "application/json", seed); got.Code != 200 {
		t.Fatal(got.Body.String())
	}
	for _, sum := range []string{"abc", strings.Repeat("A", 64), strings.Repeat("g", 64)} {
		body := `{"projectKey":"` + testProjectKey + `","path":"file","content":"after","expectedSHA256":"` + sum + `"}`
		if got := request(t, h, http.MethodPut, "/api/project-files/file", "application/json", body); got.Code != 400 {
			t.Errorf("checksum %q = %d %s", sum, got.Code, got.Body.String())
		}
	}
	badCAS := `{"projectKey":"` + testProjectKey + `","path":"file","content":"after","expectedSHA256":"` + strings.Repeat("0", 64) + `"}`
	if got := request(t, h, http.MethodPut, "/api/project-files/file", "application/json", badCAS); got.Code != 409 {
		t.Fatalf("CAS = %d %s", got.Code, got.Body.String())
	}

	storage := &Storage{ProjectRoot: root, runtime: &storageRuntime{verifyCommitted: func(int, string, uint64, uint64) error { return storageError(ErrUnsafePath, "injected", nil) }}}
	got := request(t, NewHandler(storage), http.MethodPut, "/api/project-files/file", "application/json", `{"projectKey":"`+testProjectKey+`","path":"file","content":"committed","expectedSHA256":""}`)
	if got.Code != 503 || !strings.Contains(got.Body.String(), "verify before retrying") {
		t.Fatalf("uncertain = %d %s", got.Code, got.Body.String())
	}
}

func TestHandlerCreateSkillSymlinkCollisionIsUnsafe(t *testing.T) {
	root := projectRoot(t)
	if err := os.Mkdir(filepath.Join(root, testProjectKey, "skills"), 0o750); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(root, testProjectKey, "skills", "linked")); err != nil {
		t.Fatal(err)
	}
	got := request(t, NewHandler(&Storage{ProjectRoot: root}), http.MethodPost, "/api/project-files/skills/create", "application/json", `{"projectKey":"`+testProjectKey+`","name":"linked"}`)
	if got.Code != 400 || !strings.Contains(got.Body.String(), "unsafe_path") {
		t.Fatalf("response = %d %s", got.Code, got.Body.String())
	}
	if _, err := os.Stat(filepath.Join(target, "SKILL.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("target traversed: %v", err)
	}
}

func TestHandlerRejectsInvalidRawUTF8WithoutMutation(t *testing.T) {
	h := NewHandler(&Storage{ProjectRoot: projectRoot(t)})
	valid := `{"projectKey":"` + testProjectKey + `","path":"file.txt","content":"before","expectedSHA256":""}`
	if got := request(t, h, http.MethodPut, "/api/project-files/file", "application/json", valid); got.Code != http.StatusOK {
		t.Fatalf("seed = %d %s", got.Code, got.Body.String())
	}
	bad := []byte(`{"projectKey":"` + testProjectKey + `","path":"file.txt","content":"`)
	bad = append(bad, 0xff)
	bad = append(bad, []byte(`","expectedSHA256":""}`)...)
	got := requestBytes(t, h, http.MethodPut, "/api/project-files/file", "application/json", bad)
	if got.Code != http.StatusBadRequest {
		t.Fatalf("invalid UTF-8 = %d %s", got.Code, got.Body.String())
	}
	read := request(t, h, http.MethodGet, "/api/project-files/file?projectKey="+testProjectKey+"&path=file.txt", "", "")
	if !strings.Contains(read.Body.String(), `"content":"before"`) {
		t.Fatalf("file mutated: %s", read.Body.String())
	}
}

func TestHandlerMultipartSizeFailuresAre413(t *testing.T) {
	h := NewHandler(&Storage{ProjectRoot: projectRoot(t), MaxFileBytes: 8})
	var partBody bytes.Buffer
	partWriter := multipart.NewWriter(&partBody)
	_ = partWriter.WriteField("projectKey", testProjectKey)
	_ = partWriter.WriteField("path", "big.bin")
	part, _ := partWriter.CreateFormFile("file", "ignored")
	_, _ = part.Write([]byte("123456789"))
	_ = partWriter.Close()
	if got := requestBytes(t, h, http.MethodPost, "/api/project-files/upload", partWriter.FormDataContentType(), partBody.Bytes()); got.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("part overflow = %d %s", got.Code, got.Body.String())
	}

	var totalBody bytes.Buffer
	totalWriter := multipart.NewWriter(&totalBody)
	_ = totalWriter.WriteField("projectKey", testProjectKey)
	_ = totalWriter.WriteField("path", "x")
	totalPart, _ := totalWriter.CreateFormFile("file", strings.Repeat("x", int(multipartOverhead)))
	_, _ = totalPart.Write([]byte("x"))
	_ = totalWriter.Close()
	if got := requestBytes(t, h, http.MethodPost, "/api/project-files/upload", totalWriter.FormDataContentType(), totalBody.Bytes()); got.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("total overflow = %d %s", got.Code, got.Body.String())
	}
}

func TestHandlerRejectsDuplicateJSONAndStrictQueries(t *testing.T) {
	h := NewHandler(&Storage{ProjectRoot: projectRoot(t)})
	jsonCases := []struct{ path, body string }{{"/api/project-files/skills/create", `{"projectKey":"` + testProjectKey + `","projectKey":"` + testProjectKey + `","name":"x"}`}, {"/api/project-files/file", `{"projectKey":"` + testProjectKey + `","path":"x","content":"x","content":"y"}`}, {"/api/project-files/folder", `{"projectKey":"` + testProjectKey + `","path":"x","extra":{"a":1,"a":2}}`}, {"/api/project-files/folder", `   `}, {"/api/project-files/folder", `{"projectKey":"` + testProjectKey + `","path":"x"} {}`}}
	for _, tc := range jsonCases {
		if got := request(t, h, http.MethodPost, tc.path, "application/json", tc.body); got.Code != 400 {
			t.Errorf("%s %q = %d %s", tc.path, tc.body, got.Code, got.Body.String())
		}
	}
	queries := []string{"/api/project-files/file?projectKey=" + testProjectKey, "/api/project-files/file?projectKey=" + testProjectKey + "&path=x&path=y", "/api/project-files/file?projectKey=" + testProjectKey + "&path=x&wat=1", "/api/project-files/folder?projectKey=" + testProjectKey + "&path=x", "/api/project-files/folder?projectKey=" + testProjectKey + "&path=x&recursive=True"}
	for _, url := range queries {
		if got := request(t, h, http.MethodDelete, url, "", ""); got.Code != 400 {
			t.Errorf("%s = %d %s", url, got.Code, got.Body.String())
		}
	}
}

func TestHandlerRejectsMalformedRawQueries(t *testing.T) {
	h := NewHandler(&Storage{ProjectRoot: projectRoot(t)})
	paths := []struct{ method, path string }{{http.MethodGet, "/api/project-files/skills?projectKey=" + testProjectKey + "&bad=x;y"}, {http.MethodGet, "/api/project-files/file?projectKey=" + testProjectKey + "&path=x&bad=x;y"}, {http.MethodGet, "/api/project-files/download?projectKey=" + testProjectKey + "&path=x&bad=x;y"}, {http.MethodDelete, "/api/project-files/folder?projectKey=" + testProjectKey + "&path=x&recursive=true&bad=x;y"}}
	for _, tc := range paths {
		got := request(t, h, tc.method, tc.path, "", "")
		if got.Code != 400 || !strings.Contains(got.Body.String(), "invalid_request") {
			t.Errorf("%s = %d %s", tc.path, got.Code, got.Body.String())
		}
	}
}

func TestHandlerMultipartRequiresExactlyOneOfEachField(t *testing.T) {
	h := NewHandler(&Storage{ProjectRoot: projectRoot(t)})
	build := func(fields [][2]string, files int) (string, []byte) {
		var b bytes.Buffer
		w := multipart.NewWriter(&b)
		for _, f := range fields {
			_ = w.WriteField(f[0], f[1])
		}
		for i := 0; i < files; i++ {
			p, _ := w.CreateFormFile("file", "ignored")
			_, _ = p.Write([]byte("x"))
		}
		_ = w.Close()
		return w.FormDataContentType(), b.Bytes()
	}
	cases := []struct {
		fields [][2]string
		files  int
	}{{[][2]string{{"projectKey", testProjectKey}, {"path", "x"}, {"path", "y"}}, 1}, {[][2]string{{"projectKey", testProjectKey}, {"path", "x"}, {"unknown", "x"}}, 1}, {[][2]string{{"path", "x"}}, 1}, {[][2]string{{"projectKey", testProjectKey}, {"path", "x"}}, 2}, {[][2]string{{"projectKey", testProjectKey}, {"path", string([]byte{0xff})}}, 1}}
	for _, tc := range cases {
		ct, b := build(tc.fields, tc.files)
		if got := requestBytes(t, h, http.MethodPost, "/api/project-files/upload", ct, b); got.Code != 400 {
			t.Errorf("multipart = %d %s", got.Code, got.Body.String())
		}
	}
}

func TestHandlerSecurityHeadersAndConditionalDownload(t *testing.T) {
	h := NewHandler(&Storage{ProjectRoot: projectRoot(t)})
	seed := request(t, h, http.MethodPut, "/api/project-files/file", "application/json", `{"projectKey":"`+testProjectKey+`","path":"safe name.txt","content":"body","expectedSHA256":""}`)
	if seed.Code != 200 {
		t.Fatal(seed.Body.String())
	}
	url := "/api/project-files/download?projectKey=" + testProjectKey + "&path=safe%20name.txt"
	first := request(t, h, http.MethodGet, url, "", "")
	if first.Header().Get("Cache-Control") != "no-store" || first.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(first.Header().Get("Content-Disposition"), "safe name.txt") {
		t.Fatalf("headers = %#v", first.Header())
	}
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("If-None-Match", `W/"nope", `+first.Header().Get("ETag"))
	notModified := httptest.NewRecorder()
	h.ServeHTTP(notModified, req)
	if notModified.Code != 304 || notModified.Body.Len() != 0 || notModified.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("304 = %d %q %#v", notModified.Code, notModified.Body.String(), notModified.Header())
	}
}

type deadlineBody struct {
	mu       sync.Mutex
	deadline time.Time
}

func (b *deadlineBody) currentDeadline() time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.deadline
}

func (b *deadlineBody) Read([]byte) (int, error) {
	for {
		b.mu.Lock()
		d := b.deadline
		b.mu.Unlock()
		if !d.IsZero() && time.Now().After(d) {
			return 0, timeoutReadError{}
		}
		time.Sleep(time.Millisecond)
	}
}
func (*deadlineBody) Close() error { return nil }
func (b *deadlineBody) SetReadDeadline(d time.Time) error {
	b.mu.Lock()
	b.deadline = d
	b.mu.Unlock()
	return nil
}

type timeoutReadError struct{}

func (timeoutReadError) Error() string   { return "timeout" }
func (timeoutReadError) Timeout() bool   { return true }
func (timeoutReadError) Temporary() bool { return false }
func TestHandlerBodyReadDeadline(t *testing.T) {
	h := NewHandler(&Storage{ProjectRoot: projectRoot(t)})
	h.readTimeout = 10 * time.Millisecond
	r := httptest.NewRequest(http.MethodPut, "/api/project-files/file", nil)
	r.Header.Set("Content-Type", "application/json")
	body := &deadlineBody{}
	r.Body = body
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { h.ServeHTTP(w, r); close(done) }()
	select {
	case <-done:
		if w.Code != 408 {
			t.Fatalf("status=%d %s", w.Code, w.Body.String())
		}
		if got := body.currentDeadline(); !got.IsZero() {
			t.Fatalf("deadline not cleared: %v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("handler did not time out")
	}
}

func TestHandlerCreateConflictAndCommitUncertainMapping(t *testing.T) {
	root := projectRoot(t)
	h := NewHandler(&Storage{ProjectRoot: root})
	body := `{"projectKey":"` + testProjectKey + `","name":"demo"}`
	if got := request(t, h, http.MethodPost, "/api/project-files/skills/create", "application/json", body); got.Code != http.StatusCreated {
		t.Fatalf("first create = %d %s", got.Code, got.Body.String())
	}
	if got := request(t, h, http.MethodPost, "/api/project-files/skills/create", "application/json", body); got.Code != http.StatusConflict {
		t.Fatalf("second create = %d %s", got.Code, got.Body.String())
	}

	storage := &Storage{ProjectRoot: root, runtime: &storageRuntime{fsync: func(kind string, _ int) error {
		if kind == "directory" {
			return errors.New("injected sync failure")
		}
		return nil
	}}}
	uncertain := request(t, NewHandler(storage), http.MethodPut, "/api/project-files/file", "application/json", `{"projectKey":"`+testProjectKey+`","path":"demo/SKILL.md","content":"possibly committed"}`)
	if uncertain.Code != http.StatusServiceUnavailable || !strings.Contains(uncertain.Body.String(), "commit_uncertain") || !strings.Contains(uncertain.Body.String(), "verify before retrying") {
		t.Fatalf("uncertain = %d %s", uncertain.Code, uncertain.Body.String())
	}
}

func TestHandlerFolderUploadDownloadAndTraversal(t *testing.T) {
	h := NewHandler(&Storage{ProjectRoot: projectRoot(t), MaxFileBytes: 1024})
	mkdir := request(t, h, http.MethodPost, "/api/project-files/folder", "application/json", `{"projectKey":"`+testProjectKey+`","path":"demo"}`)
	if mkdir.Code != http.StatusCreated {
		t.Fatalf("mkdir = %d %s", mkdir.Code, mkdir.Body.String())
	}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("projectKey", testProjectKey)
	_ = mw.WriteField("path", "demo/raw.bin")
	part, _ := mw.CreateFormFile("file", "../../ignored")
	_, _ = part.Write([]byte{0, 1, 2, 255})
	_ = mw.Close()
	upload := requestBytes(t, h, http.MethodPost, "/api/project-files/upload", mw.FormDataContentType(), body.Bytes())
	if upload.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s", upload.Code, upload.Body.String())
	}
	download := request(t, h, http.MethodGet, "/api/project-files/download?projectKey="+testProjectKey+"&path=demo%2Fraw.bin", "", "")
	if download.Code != http.StatusOK || !bytes.Equal(download.Body.Bytes(), []byte{0, 1, 2, 255}) {
		t.Fatalf("download = %d %v", download.Code, download.Body.Bytes())
	}
	textRead := request(t, h, http.MethodGet, "/api/project-files/file?projectKey="+testProjectKey+"&path=demo%2Fraw.bin", "", "")
	if textRead.Code != http.StatusBadRequest || !strings.Contains(textRead.Body.String(), "invalid_text") {
		t.Fatalf("binary text read = %d %s", textRead.Code, textRead.Body.String())
	}
	traversal := request(t, h, http.MethodGet, "/api/project-files/download?projectKey="+testProjectKey+"&path=..%2Fsecret", "", "")
	if traversal.Code != http.StatusBadRequest || strings.Contains(traversal.Body.String(), t.TempDir()) {
		t.Fatalf("traversal = %d %s", traversal.Code, traversal.Body.String())
	}
	rm := request(t, h, http.MethodDelete, "/api/project-files/folder?projectKey="+testProjectKey+"&path=demo&recursive=true", "", "")
	if rm.Code != http.StatusNoContent {
		t.Fatalf("remove = %d %s", rm.Code, rm.Body.String())
	}
}

func request(t *testing.T, h http.Handler, method, url, contentType, body string) *httptest.ResponseRecorder {
	t.Helper()
	return requestBytes(t, h, method, url, contentType, []byte(body))
}
func requestBytes(t *testing.T, h http.Handler, method, url, contentType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, url, bytes.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func jsonString(t *testing.T, value string) string {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func projectRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, testProjectKey), 0o750); err != nil {
		t.Fatal(err)
	}
	return root
}
