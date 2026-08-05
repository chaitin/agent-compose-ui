package volumefiles

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type inspectorFunc func(context.Context, string) (Volume, error)

func (f inspectorFunc) InspectVolume(ctx context.Context, name string) (Volume, error) {
	return f(ctx, name)
}

const validProject = "ws_0123456789abcdef0123456789abcdef"

func TestResolverManagedLocalVolume(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "nested", "volume")
	mustMkdirAll(t, path)
	calls := 0
	r := Resolver{Root: root, Inspector: inspectorFunc(func(_ context.Context, name string) (Volume, error) {
		calls++
		return Volume{Name: name, Driver: "local", Path: path, Labels: map[string]string{
			"agent-compose-ui.managed":     "true",
			"agent-compose-ui.project-key": validProject,
		}}, nil
	})}

	got, err := r.Resolve(context.Background(), validProject, "cache_1")
	if err != nil || got != path {
		t.Fatalf("Resolve() = %q, %v; want %q, nil", got, err, path)
	}
	if calls != 1 {
		t.Fatalf("inspector calls = %d, want 1", calls)
	}
}

func TestResolverRejectsInvalidInputsBeforeInspection(t *testing.T) {
	root := t.TempDir()
	tests := []struct {
		name, root, project, volume string
		nilInspector                bool
		nilContext                  bool
	}{
		{name: "nil inspector", root: root, project: validProject, volume: "vol", nilInspector: true},
		{name: "nil context", root: root, project: validProject, volume: "vol", nilContext: true},
		{name: "empty root", project: validProject, volume: "vol"},
		{name: "relative root", root: "relative", project: validProject, volume: "vol"},
		{name: "unclean root", root: root + string(filepath.Separator) + ".." + string(filepath.Separator) + filepath.Base(root), project: validProject, volume: "vol"},
		{name: "filesystem root", root: string(filepath.Separator), project: validProject, volume: "vol"},
		{name: "bad project prefix", root: root, project: "xx_0123456789abcdef0123456789abcdef", volume: "vol"},
		{name: "bad project case", root: root, project: "ws_0123456789ABCDEF0123456789abcdef", volume: "vol"},
		{name: "volume slash", root: root, project: validProject, volume: "a/b"},
		{name: "volume control", root: root, project: validProject, volume: "a\nb"},
		{name: "volume empty", root: root, project: validProject},
		{name: "volume too long", root: root, project: validProject, volume: strings.Repeat("a", 256)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			var inspector VolumeInspector = inspectorFunc(func(context.Context, string) (Volume, error) {
				calls++
				return Volume{}, nil
			})
			if tt.nilInspector {
				inspector = nil
			}
			ctx := context.Background()
			if tt.nilContext {
				ctx = nil
			}
			_, err := (Resolver{Root: tt.root, Inspector: inspector}).Resolve(ctx, tt.project, tt.volume)
			assertCode(t, err, CodeInvalid)
			if calls != 0 {
				t.Fatalf("inspector called %d times", calls)
			}
		})
	}
}

func TestResolverRejectsTypedNilContextBeforeMethodOrInspectorCall(t *testing.T) {
	var ctx *panicContext
	calls := 0
	r := Resolver{Root: t.TempDir(), Inspector: inspectorFunc(func(context.Context, string) (Volume, error) {
		calls++
		return Volume{}, nil
	})}

	_, err := r.Resolve(ctx, validProject, "vol")
	assertCode(t, err, CodeInvalid)
	if calls != 0 {
		t.Fatalf("inspector called %d times", calls)
	}
}

type panicContext struct{}

func (c *panicContext) Deadline() (time.Time, bool) { panic("typed-nil context method called") }
func (c *panicContext) Done() <-chan struct{}       { panic("typed-nil context method called") }
func (c *panicContext) Err() error                  { panic("typed-nil context method called") }
func (c *panicContext) Value(any) any               { panic("typed-nil context method called") }

func TestResolverAcceptsDaemonCompatibleLongVolumeNames(t *testing.T) {
	for _, length := range []int{216, 255} {
		t.Run(fmt.Sprintf("length_%d", length), func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "volume")
			mustMkdirAll(t, path)
			name := strings.Repeat("a", length)
			got, err := resolverForNamedPath(root, path, name).Resolve(context.Background(), validProject, name)
			if err != nil || got != path {
				t.Fatalf("Resolve() = %q, %v; want %q, nil", got, err, path)
			}
		})
	}
}

func TestResolverRejectsUntrustedVolumeMetadata(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "vol")
	mustMkdirAll(t, path)
	base := Volume{Name: "vol", Driver: "local", Path: path, Labels: map[string]string{
		"agent-compose-ui.managed": "true", "agent-compose-ui.project-key": validProject,
	}}
	tests := []struct {
		name string
		edit func(*Volume)
	}{
		{"wrong project", func(v *Volume) { v.Labels["agent-compose-ui.project-key"] = "ws_ffffffffffffffffffffffffffffffff" }},
		{"missing project label", func(v *Volume) { delete(v.Labels, "agent-compose-ui.project-key") }},
		{"missing managed label", func(v *Volume) { delete(v.Labels, "agent-compose-ui.managed") }},
		{"managed key case variant", func(v *Volume) {
			delete(v.Labels, "agent-compose-ui.managed")
			v.Labels["Agent-Compose-UI.Managed"] = "true"
		}},
		{"managed label case", func(v *Volume) { v.Labels["agent-compose-ui.managed"] = "TRUE" }},
		{"wrong driver", func(v *Volume) { v.Driver = "LOCAL" }},
		{"mismatched name", func(v *Volume) { v.Name = "other" }},
		{"missing name", func(v *Volume) { v.Name = "" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := base
			v.Labels = map[string]string{}
			for k, value := range base.Labels {
				v.Labels[k] = value
			}
			tt.edit(&v)
			calls := 0
			r := Resolver{Root: root, Inspector: inspectorFunc(func(context.Context, string) (Volume, error) { calls++; return v, nil })}
			_, err := r.Resolve(context.Background(), validProject, "vol")
			assertCode(t, err, CodeForbidden)
			if calls != 1 {
				t.Fatalf("calls = %d", calls)
			}
		})
	}
}

func TestResolverMapsInspectorErrorsSafely(t *testing.T) {
	tests := []struct {
		name  string
		input error
		code  Code
		is    error
	}{
		{"not found", errors.Join(ErrNotFound, errors.New("secret daemon detail")), CodeNotFound, ErrNotFound},
		{"unavailable", errors.Join(ErrUnavailable, errors.New("secret daemon detail")), CodeUnavailable, ErrUnavailable},
		{"failure", errors.New("secret daemon detail"), CodeUpstream, ErrUpstream},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			r := Resolver{Root: root, Inspector: inspectorFunc(func(context.Context, string) (Volume, error) { return Volume{}, tt.input })}
			_, err := r.Resolve(context.Background(), validProject, "vol")
			assertCode(t, err, tt.code)
			if !errors.Is(err, tt.is) {
				t.Fatalf("errors.Is(%v) false", tt.is)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatalf("error leaks upstream details: %q", err)
			}
		})
	}
}

func TestResolverPropagatesContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	r := Resolver{Root: t.TempDir(), Inspector: inspectorFunc(func(context.Context, string) (Volume, error) { calls++; return Volume{}, nil })}
	_, err := r.Resolve(ctx, validProject, "vol")
	if !errors.Is(err, context.Canceled) || calls != 0 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}

	ctx2, cancel2 := context.WithCancel(context.Background())
	r.Inspector = inspectorFunc(func(context.Context, string) (Volume, error) { calls++; cancel2(); return Volume{}, context.Canceled })
	_, err = r.Resolve(ctx2, validProject, "vol")
	if !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
}

func TestResolverRejectsUnsafePhysicalPaths(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	mustMkdirAll(t, filepath.Join(root, "ok"))
	mustWrite(t, filepath.Join(root, "file"))
	if err := syscall.Mkfifo(filepath.Join(root, "fifo"), 0o600); err != nil {
		t.Fatal(err)
	}
	tests := []struct{ name, path string }{
		{"empty", ""}, {"relative", "relative"},
		{"unclean", root + string(filepath.Separator) + "ok" + string(filepath.Separator) + ".." + string(filepath.Separator) + "ok"},
		{"outside", outside}, {"equal root", root},
		{"sibling prefix", root + "2"}, {"file", filepath.Join(root, "file")},
		{"fifo", filepath.Join(root, "fifo")}, {"nonexistent", filepath.Join(root, "missing")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := resolverForPath(root, tt.path)
			_, err := r.Resolve(context.Background(), validProject, "vol")
			assertCode(t, err, CodeForbidden)
			if strings.Contains(err.Error(), root) || strings.Contains(err.Error(), outside) {
				t.Fatalf("path leaked: %q", err)
			}
		})
	}
}

func TestResolverRejectsSymlinksAndRootSymlink(t *testing.T) {
	root := t.TempDir()
	out := t.TempDir()
	mustMkdirAll(t, filepath.Join(root, "real", "leaf"))
	if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "parent-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "real", "leaf"), filepath.Join(root, "leaf-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(out, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(root, "parent-link", "leaf"), filepath.Join(root, "leaf-link"), filepath.Join(root, "escape")} {
		_, err := resolverForPath(root, path).Resolve(context.Background(), validProject, "vol")
		assertCode(t, err, CodeForbidden)
	}
	rootLink := filepath.Join(t.TempDir(), "root-link")
	if err := os.Symlink(root, rootLink); err != nil {
		t.Fatal(err)
	}
	_, err := resolverForPath(rootLink, filepath.Join(rootLink, "real", "leaf")).Resolve(context.Background(), validProject, "vol")
	assertCode(t, err, CodeForbidden)
}

func TestResolverRequiresRootDirectoryToExist(t *testing.T) {
	parent := t.TempDir()
	missingRoot := filepath.Join(parent, "missing")
	_, err := resolverForPath(missingRoot, filepath.Join(missingRoot, "vol")).Resolve(context.Background(), validProject, "vol")
	assertCode(t, err, CodeForbidden)

	rootFile := filepath.Join(parent, "root-file")
	mustWrite(t, rootFile)
	_, err = resolverForPath(rootFile, filepath.Join(rootFile, "vol")).Resolve(context.Background(), validProject, "vol")
	assertCode(t, err, CodeForbidden)
}

func TestResolverCancellationBetweenComponentsDoesNotLeakFD(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "one", "two")
	mustMkdirAll(t, path)
	before := openFDCount(t)
	for range 100 {
		// Resolve checks Err before and after inspection, then before each path
		// component. Cancel on the second component boundary, after "one" was
		// opened, to exercise ownership of the current non-root descriptor.
		ctx := &cancelOnErrCall{cancelAt: 4}
		_, err := resolverForPath(root, path).Resolve(ctx, validProject, "vol")
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Resolve() error = %v, want context.Canceled", err)
		}
	}
	after := openFDCount(t)
	if after != before {
		t.Fatalf("open fd count changed from %d to %d", before, after)
	}
}

type cancelOnErrCall struct {
	calls    int
	cancelAt int
}

func (*cancelOnErrCall) Deadline() (time.Time, bool) { return time.Time{}, false }
func (*cancelOnErrCall) Done() <-chan struct{}       { return nil }
func (*cancelOnErrCall) Value(any) any               { return nil }
func (c *cancelOnErrCall) Err() error {
	c.calls++
	if c.calls >= c.cancelAt {
		return context.Canceled
	}
	return nil
}

func openFDCount(t *testing.T) int {
	t.Helper()
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Skipf("Linux fd accounting unavailable: %v", err)
	}
	return len(entries)
}

func resolverForPath(root, path string) Resolver {
	return resolverForNamedPath(root, path, "")
}

func resolverForNamedPath(root, path, responseName string) Resolver {
	return Resolver{Root: root, Inspector: inspectorFunc(func(_ context.Context, name string) (Volume, error) {
		if responseName != "" {
			name = responseName
		}
		return Volume{Name: name, Driver: "local", Path: path, Labels: map[string]string{
			"agent-compose-ui.managed": "true", "agent-compose-ui.project-key": validProject,
		}}, nil
	})}
}

func assertCode(t *testing.T, err error, code Code) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s error", code)
	}
	var coded *Error
	if !errors.As(err, &coded) || coded.Code != code {
		t.Fatalf("error = %#v, want code %s", err, code)
	}
}

func mustMkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
}
func mustWrite(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestResolverRejectsReservedTransactionSubtree(t *testing.T) {
	root := t.TempDir()
	txn := filepath.Join(root, ".agent-compose-ui-transactions")
	mustMkdirAll(t, txn)
	mustMkdirAll(t, filepath.Join(txn, "child"))
	for _, p := range []string{txn, filepath.Join(txn, "child")} {
		r := resolverForPath(root, p)
		r.TransactionRoot = txn
		if _, err := r.Resolve(context.Background(), validProject, "vol"); !errors.Is(err, ErrForbidden) {
			t.Errorf("Resolve(%q)=%v", p, err)
		}
	}
}
