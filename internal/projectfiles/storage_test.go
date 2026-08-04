package projectfiles

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const (
	projectA = "ws_00000000000000000000000000000001"
	projectB = "ws_00000000000000000000000000000002"
)

func newTestStorage(t *testing.T) (*Storage, string) {
	t.Helper()
	root := t.TempDir()
	for _, key := range []string{projectA, projectB} {
		if err := os.Mkdir(filepath.Join(root, key), 0o750); err != nil {
			t.Fatal(err)
		}
	}
	return &Storage{ProjectRoot: root, MaxFileBytes: 1024}, root
}

func TestCreateDirectoryFileConcurrentExactlyOneWinner(t *testing.T) {
	s, _ := newTestStorage(t)
	for iteration := 0; iteration < 100; iteration++ {
		directory := fmt.Sprintf("skill_%d", iteration)
		start := make(chan struct{})
		errs := make(chan error, 2)
		for i := 0; i < 2; i++ {
			go func() {
				<-start
				_, err := s.CreateDirectoryFile(projectA, "skills", directory, "SKILL.md", []byte("body"))
				errs <- err
			}()
		}
		close(start)
		first, second := <-errs, <-errs
		if (first == nil) == (second == nil) {
			t.Fatalf("iteration %d errors = %v, %v", iteration, first, second)
		}
		loser := first
		if loser == nil {
			loser = second
		}
		if !errors.Is(loser, ErrConflict) {
			t.Fatalf("iteration %d loser = %v", iteration, loser)
		}
	}
}

func TestCreateDirectoryFileRollbackAndCommitUncertain(t *testing.T) {
	s, _ := newTestStorage(t)
	s.runtime = &storageRuntime{fsync: func(kind string, _ int) error {
		if kind == "file" {
			return errors.New("injected")
		}
		return nil
	}}
	if _, err := s.CreateDirectoryFile(projectA, "skills", "rollback", "SKILL.md", []byte("body")); !errors.Is(err, ErrStorage) {
		t.Fatalf("rollback error = %v", err)
	}
	if _, err := s.List(projectA, "skills", "rollback"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rollback directory remained: %v", err)
	}

	s.runtime = &storageRuntime{fsync: func(kind string, _ int) error {
		if kind == "directory" {
			return errors.New("injected")
		}
		return nil
	}}
	if _, err := s.CreateDirectoryFile(projectA, "skills", "uncertain", "SKILL.md", []byte("body")); !errors.Is(err, ErrCommitUncertain) {
		t.Fatalf("uncertain error = %v", err)
	}
	file, err := s.Read(projectA, "skills", "uncertain/SKILL.md")
	if err != nil || string(file.Content) != "body" {
		t.Fatalf("committed file = %q, %v", file.Content, err)
	}
}

func TestWriteChecksumSyntaxIsDistinctFromConflict(t *testing.T) {
	s, _ := newTestStorage(t)
	if _, err := s.Write(projectA, "skills", "file", []byte("before"), ""); err != nil {
		t.Fatal(err)
	}
	for _, checksum := range []string{"abc", strings.Repeat("A", 64), strings.Repeat("g", 64)} {
		if _, err := s.Write(projectA, "skills", "file", []byte("after"), checksum); !errors.Is(err, ErrInvalidChecksum) {
			t.Errorf("checksum %q error = %v", checksum, err)
		}
	}
	if _, err := s.Write(projectA, "skills", "file", []byte("after"), strings.Repeat("0", 64)); !errors.Is(err, ErrConflict) {
		t.Fatalf("valid mismatch = %v", err)
	}
	file, _ := s.Read(projectA, "skills", "file")
	if string(file.Content) != "before" {
		t.Fatalf("mutated content = %q", file.Content)
	}
}

func TestCreateDirectoryFileRejectsSymlinkNameAsUnsafe(t *testing.T) {
	s, root := newTestStorage(t)
	target := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, projectA, "skills"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, projectA, "skills", "linked")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateDirectoryFile(projectA, "skills", "linked", "SKILL.md", []byte("body")); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "SKILL.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("target traversed: %v", err)
	}
}

func TestWritePostRenameVerificationFailureIsCommitUncertain(t *testing.T) {
	s, _ := newTestStorage(t)
	s.runtime = &storageRuntime{verifyCommitted: func(int, string, uint64, uint64) error {
		return storageError(ErrUnsafePath, "injected verification", nil)
	}}
	_, err := s.Write(projectA, "skills", "file", []byte("committed"), "")
	if !errors.Is(err, ErrCommitUncertain) || !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("error = %v", err)
	}
	file, readErr := s.Read(projectA, "skills", "file")
	if readErr != nil || string(file.Content) != "committed" {
		t.Fatalf("state = %q, %v", file.Content, readErr)
	}
}

func TestCreateDirectoryFilePostRenameFailureDoesNotRollback(t *testing.T) {
	s, _ := newTestStorage(t)
	s.runtime = &storageRuntime{verifyCommitted: func(int, string, uint64, uint64) error {
		return storageError(ErrUnsafePath, "injected verification", nil)
	}}
	_, err := s.CreateDirectoryFile(projectA, "skills", "created", "SKILL.md", []byte("committed"))
	if !errors.Is(err, ErrCommitUncertain) || !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("error = %v", err)
	}
	file, readErr := s.Read(projectA, "skills", "created/SKILL.md")
	if readErr != nil || string(file.Content) != "committed" {
		t.Fatalf("state = %q, %v", file.Content, readErr)
	}
}

func waitSignal(t *testing.T, ch <-chan struct{}) bool {
	t.Helper()
	select {
	case <-ch:
		return true
	case <-time.After(2 * time.Second):
		t.Errorf("timed out waiting for signal")
		return false
	}
}

func receiveValue[T any](t *testing.T, ch <-chan T) (T, bool) {
	t.Helper()
	select {
	case value := <-ch:
		return value, true
	case <-time.After(2 * time.Second):
		var zero T
		t.Errorf("timed out waiting for result")
		return zero, false
	}
}

func TestStorageConditionalWritesAreSerialized(t *testing.T) {
	s, _ := newTestStorage(t)
	initial, err := s.Write(projectA, "skills", "cas.txt", []byte("initial"), "")
	if err != nil {
		t.Fatal(err)
	}

	ready := make(chan struct{})
	release := make(chan struct{})
	var arrivals atomic.Int32
	s.runtime = &storageRuntime{hook: func(operation, stage, projectKey, relative string, body []byte) {
		if operation == "write" && stage == "before-lock" && relative == "cas.txt" {
			if arrivals.Add(1) == 2 {
				close(ready)
			}
			waitSignal(t, release)
		}
	}}

	type result struct {
		file File
		err  error
	}
	results := make(chan result, 2)
	for _, body := range [][]byte{[]byte("writer-one"), []byte("writer-two")} {
		body := body
		go func() {
			file, err := s.Write(projectA, "skills", "cas.txt", body, initial.SHA256)
			results <- result{file: file, err: err}
		}()
	}
	if !waitSignal(t, ready) {
		return
	}
	close(release)
	var winner File
	var successes, conflicts int
	for range 2 {
		result, ok := receiveValue(t, results)
		if !ok {
			return
		}
		switch {
		case result.err == nil:
			successes++
			winner = result.file
		case errors.Is(result.err, ErrConflict):
			conflicts++
		default:
			t.Fatalf("unexpected write error: %v", result.err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
	final, err := s.Read(projectA, "skills", "cas.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(final.Content, winner.Content) || final.SHA256 != winner.SHA256 {
		t.Fatalf("final=%q/%s winner=%q/%s", final.Content, final.SHA256, winner.Content, winner.SHA256)
	}
	namespaceLocks.mu.Lock()
	remainingLocks := len(namespaceLocks.locks)
	namespaceLocks.mu.Unlock()
	if remainingLocks != 0 {
		t.Fatalf("target lock map retained %d entries", remainingLocks)
	}
}

func TestStorageConditionalWriteSerializesWithDirectRemove(t *testing.T) {
	testConditionalWriteRemoveOrdering(t, "guarded.txt", "guarded.txt", false)
}

func TestStorageConditionalDescendantWriteSerializesWithRecursiveAncestorRemove(t *testing.T) {
	testConditionalWriteRemoveOrdering(t, "tree/guarded.txt", "tree", true)
}

func testConditionalWriteRemoveOrdering(t *testing.T, writePath, removePath string, recursive bool) {
	t.Helper()
	s, _ := newTestStorage(t)
	if parent := path.Dir(writePath); parent != "." {
		if err := s.Mkdir(projectA, "skills", parent); err != nil {
			t.Fatal(err)
		}
	}
	initial, err := s.Write(projectA, "skills", writePath, []byte("initial"), "")
	if err != nil {
		t.Fatal(err)
	}
	writePaused := make(chan struct{})
	removeQueued := make(chan struct{})
	releaseWrite := make(chan struct{})
	s.runtime = &storageRuntime{hook: func(operation, stage, projectKey, relative string, body []byte) {
		switch {
		case operation == "write" && stage == "after-expected" && projectKey == projectA && relative == writePath:
			close(writePaused)
			waitSignal(t, releaseWrite)
		case operation == "remove" && stage == "queued" && projectKey == projectA && relative == removePath:
			close(removeQueued)
		}
	}}

	writeResult := make(chan error, 1)
	go func() {
		_, err := s.Write(projectA, "skills", writePath, []byte("conditional"), initial.SHA256)
		writeResult <- err
	}()
	if !waitSignal(t, writePaused) {
		return
	}
	removeResult := make(chan error, 1)
	go func() { removeResult <- s.Remove(projectA, "skills", removePath, recursive) }()
	if !waitSignal(t, removeQueued) {
		return
	}
	close(releaseWrite)
	if err, ok := receiveValue(t, writeResult); !ok || err != nil {
		t.Fatalf("conditional write = %v", err)
	}
	if err, ok := receiveValue(t, removeResult); !ok || err != nil {
		t.Fatalf("ordered remove = %v", err)
	}
	if _, err := s.Read(projectA, "skills", writePath); !errors.Is(err, ErrNotFound) {
		t.Fatalf("final read = %v; stale conditional write survived remove", err)
	}
}

func TestStorageNamespaceLocksDoNotBlockDifferentProjects(t *testing.T) {
	s, _ := newTestStorage(t)
	for _, key := range []string{projectA, projectB} {
		if _, err := s.Write(key, "skills", "file", []byte("initial"), ""); err != nil {
			t.Fatal(err)
		}
	}
	paused := make(chan struct{})
	release := make(chan struct{})
	s.runtime = &storageRuntime{hook: func(operation, stage, projectKey, relative string, body []byte) {
		if operation == "write" && stage == "after-expected" && projectKey == projectA && relative == "file" {
			close(paused)
			waitSignal(t, release)
		}
	}}

	first := make(chan error, 1)
	go func() {
		_, err := s.Write(projectA, "skills", "file", []byte("blocked"), "")
		first <- err
	}()
	if !waitSignal(t, paused) {
		return
	}
	second := make(chan error, 1)
	go func() {
		_, err := s.Write(projectB, "skills", "file", []byte("independent"), "")
		second <- err
	}()
	select {
	case err := <-second:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("different project was blocked by namespace lock")
	}
	close(release)
	if err, ok := receiveValue(t, first); !ok || err != nil {
		t.Fatal(err)
	}
	namespaceLocks.mu.Lock()
	remaining := len(namespaceLocks.locks)
	namespaceLocks.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("namespace lock map retained %d entries", remaining)
	}
}

func TestStorageNamespaceLockUsesOpenedRootIdentityAcrossParentSymlinkAliases(t *testing.T) {
	base := t.TempDir()
	realParent := filepath.Join(base, "real-parent")
	realRoot := filepath.Join(realParent, "project-root")
	if err := os.MkdirAll(filepath.Join(realRoot, projectA), 0o750); err != nil {
		t.Fatal(err)
	}
	aliasParent := filepath.Join(base, "alias-parent")
	if err := os.Symlink(realParent, aliasParent); err != nil {
		t.Fatal(err)
	}
	realStorage := &Storage{ProjectRoot: realRoot, MaxFileBytes: 1024}
	aliasStorage := &Storage{ProjectRoot: filepath.Join(aliasParent, "project-root"), MaxFileBytes: 1024}
	initial, err := realStorage.Write(projectA, "skills", "aliased.txt", []byte("initial"), "")
	if err != nil {
		t.Fatal(err)
	}

	writePaused := make(chan struct{})
	removeQueued := make(chan struct{})
	allowRemoveToWait := make(chan struct{})
	releaseWrite := make(chan struct{})
	sharedRuntime := &storageRuntime{hook: func(operation, stage, projectKey, relative string, body []byte) {
		switch {
		case operation == "write" && stage == "after-expected" && relative == "aliased.txt":
			close(writePaused)
			waitSignal(t, releaseWrite)
		case operation == "remove" && stage == "queued" && relative == "aliased.txt":
			close(removeQueued)
			waitSignal(t, allowRemoveToWait)
		}
	}}
	realStorage.runtime = sharedRuntime
	aliasStorage.runtime = sharedRuntime

	writeResult := make(chan error, 1)
	go func() {
		_, err := realStorage.Write(projectA, "skills", "aliased.txt", []byte("conditional"), initial.SHA256)
		writeResult <- err
	}()
	if !waitSignal(t, writePaused) {
		return
	}
	removeResult := make(chan error, 1)
	go func() { removeResult <- aliasStorage.Remove(projectA, "skills", "aliased.txt", false) }()
	if !waitSignal(t, removeQueued) {
		return
	}
	namespaceLocks.mu.Lock()
	lockEntriesWhileQueued := len(namespaceLocks.locks)
	namespaceLocks.mu.Unlock()
	close(allowRemoveToWait)
	close(releaseWrite)
	if err, ok := receiveValue(t, writeResult); !ok || err != nil {
		t.Fatalf("conditional write = %v", err)
	}
	if err, ok := receiveValue(t, removeResult); !ok || err != nil {
		t.Fatalf("aliased remove = %v", err)
	}
	if lockEntriesWhileQueued != 1 {
		t.Fatalf("same opened root produced %d namespace lock entries", lockEntriesWhileQueued)
	}
	if _, err := realStorage.Read(projectA, "skills", "aliased.txt"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("final read = %v", err)
	}
	namespaceLocks.mu.Lock()
	remaining := len(namespaceLocks.locks)
	namespaceLocks.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("namespace lock map retained %d entries", remaining)
	}
}

func TestStorageWriteReturnsCommittedFileWhenImmediatelyReplaced(t *testing.T) {
	s, _ := newTestStorage(t)
	committed := make(chan struct{})
	release := make(chan struct{})
	s.runtime = &storageRuntime{hook: func(operation, stage, projectKey, relative string, body []byte) {
		if operation == "write" && stage == "after-rename" && relative == "return.txt" && bytes.Equal(body, []byte("mine")) {
			close(committed)
			waitSignal(t, release)
		}
	}}

	type result struct {
		file File
		err  error
	}
	firstResult := make(chan result, 1)
	go func() {
		file, err := s.Write(projectA, "skills", "return.txt", []byte("mine"), "")
		firstResult <- result{file, err}
	}()
	if !waitSignal(t, committed) {
		return
	}
	if _, err := s.Write(projectA, "skills", "return.txt", []byte("replacement"), ""); err != nil {
		t.Fatal(err)
	}
	close(release)
	first, ok := receiveValue(t, firstResult)
	if !ok {
		return
	}
	if first.err != nil {
		t.Fatal(first.err)
	}
	wantHash := sha256Hex([]byte("mine"))
	if string(first.file.Content) != "mine" || first.file.SHA256 != wantHash || first.file.Size != 4 {
		t.Fatalf("first result = %+v", first.file)
	}
}

func TestStorageRejectsHardLinkedRegularFiles(t *testing.T) {
	for _, test := range []struct {
		name       string
		linkSource func(root string) string
	}{
		{name: "outside scope", linkSource: func(root string) string { return filepath.Join(root, "outside-hardlink") }},
		{name: "other project", linkSource: func(root string) string { return filepath.Join(root, projectB, "other-project-file") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, root := newTestStorage(t)
			source := test.linkSource(root)
			if err := os.WriteFile(source, []byte("protected"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(filepath.Join(root, projectA, "skills"), 0o750); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(root, projectA, "skills", "linked")
			if err := os.Link(source, target); err != nil {
				t.Fatal(err)
			}
			if _, err := s.List(projectA, "skills", ""); !errors.Is(err, ErrUnsafePath) {
				t.Errorf("list hardlink = %v", err)
			}
			if _, err := s.Read(projectA, "skills", "linked"); !errors.Is(err, ErrUnsafePath) {
				t.Errorf("read hardlink = %v", err)
			}
			if _, err := s.Write(projectA, "skills", "linked", []byte("changed"), ""); !errors.Is(err, ErrUnsafePath) {
				t.Errorf("write hardlink = %v", err)
			}
			if err := s.Remove(projectA, "skills", "linked", false); !errors.Is(err, ErrUnsafePath) {
				t.Errorf("remove hardlink = %v", err)
			}
			content, err := os.ReadFile(source)
			if err != nil || string(content) != "protected" {
				t.Fatalf("source content = %q, %v", content, err)
			}
			if _, err := os.Lstat(target); err != nil {
				t.Fatalf("target link was removed: %v", err)
			}
		})
	}
}

func TestStorageRecursiveRemoveRejectsHardLinks(t *testing.T) {
	s, root := newTestStorage(t)
	source := filepath.Join(root, "recursive-source")
	if err := os.WriteFile(source, []byte("protected"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.Mkdir(projectA, "skills", "tree"); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(source, filepath.Join(root, projectA, "skills", "tree", "linked")); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(projectA, "skills", "tree", true); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("recursive remove = %v", err)
	}
	if content, err := os.ReadFile(source); err != nil || string(content) != "protected" {
		t.Fatalf("source content = %q, %v", content, err)
	}
}

func TestBoundedReadLimitDoesNotOverflow(t *testing.T) {
	if got := boundedReadLimit(math.MaxInt64); got != math.MaxInt64 {
		t.Fatalf("limit = %d", got)
	}
	if got := boundedReadLimit(12); got != 13 {
		t.Fatalf("ordinary limit = %d", got)
	}
}

func TestStorageListEntryLimit(t *testing.T) {
	s, _ := newTestStorage(t)
	s.runtime = &storageRuntime{listLimit: 2}
	for _, name := range []string{"b", "a"} {
		if _, err := s.Write(projectA, "skills", name, []byte(name), ""); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := s.List(projectA, "skills", "")
	if err != nil || len(entries) != 2 || entries[0].Name != "a" || entries[1].Name != "b" {
		t.Fatalf("at limit: entries=%v err=%v", entries, err)
	}
	if _, err := s.Write(projectA, "skills", "c", []byte("c"), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.List(projectA, "skills", ""); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("over limit = %v", err)
	}
}

func TestStorageRecursiveRemoveEntryLimit(t *testing.T) {
	makeTree := func(t *testing.T, limit int, names ...string) (*Storage, string) {
		t.Helper()
		s, root := newTestStorage(t)
		s.runtime = &storageRuntime{removeLimit: limit}
		if err := s.Mkdir(projectA, "skills", "tree"); err != nil {
			t.Fatal(err)
		}
		for _, name := range names {
			if _, err := s.Write(projectA, "skills", "tree/"+name, []byte(name), ""); err != nil {
				t.Fatal(err)
			}
		}
		return s, root
	}
	t.Run("at limit", func(t *testing.T) {
		s, _ := makeTree(t, 2, "a", "b")
		if err := s.Remove(projectA, "skills", "tree", true); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("over limit", func(t *testing.T) {
		s, root := makeTree(t, 2, "a", "b", "c")
		if err := s.Remove(projectA, "skills", "tree", true); !errors.Is(err, ErrLimitExceeded) {
			t.Fatalf("remove over limit = %v", err)
		}
		if _, err := os.Lstat(filepath.Join(root, projectA, "skills", "tree")); err != nil {
			t.Fatalf("tree unexpectedly absent: %v", err)
		}
	})
}

func TestStoragePathComponentLimit(t *testing.T) {
	s, _ := newTestStorage(t)
	s.runtime = &storageRuntime{pathLimit: 2}
	if err := s.Mkdir(projectA, "skills", "one/two"); err != nil {
		t.Fatalf("at limit = %v", err)
	}
	if err := s.Mkdir(projectA, "skills", "one/two/three"); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("over limit = %v", err)
	}
}

func TestValidatePathRawByteLimit(t *testing.T) {
	exact := strings.Repeat("é", MaxRelativePathBytes/2)
	if len(exact) != MaxRelativePathBytes {
		t.Fatalf("test path bytes = %d", len(exact))
	}
	if _, _, err := validatePath(exact, false, MaxPathComponents); err != nil {
		t.Fatalf("exact byte limit = %v", err)
	}
	if _, _, err := validatePath(exact+"x", false, MaxPathComponents); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("over byte limit = %v", err)
	}
}

func TestValidatePathComponentBoundaryBeforeSplit(t *testing.T) {
	exact := strings.TrimSuffix(strings.Repeat("a/", MaxPathComponents), "/")
	parts, _, err := validatePath(exact, false, MaxPathComponents)
	if err != nil || len(parts) != MaxPathComponents {
		t.Fatalf("exact component limit: parts=%d err=%v", len(parts), err)
	}
	over := exact + "/a"
	if _, _, err := validatePath(over, false, MaxPathComponents); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("over component limit = %v", err)
	}
	veryLarge := strings.Repeat("a/", 100_000)
	if _, _, err := validatePath(veryLarge, false, MaxPathComponents); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("very large slash-heavy path = %v", err)
	}
}

func TestStorageRecursiveRemoveDepthLimitIncludesHostCreatedEntries(t *testing.T) {
	s, root := newTestStorage(t)
	s.runtime = &storageRuntime{pathLimit: 2, removeLimit: 10}
	deep := filepath.Join(root, projectA, "skills", "tree", "child", "too-deep")
	if err := os.MkdirAll(deep, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(projectA, "skills", "tree", true); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("deep recursive remove = %v", err)
	}
}

func TestStorageRecursiveRemoveRejectsExternallyReplacedDirectory(t *testing.T) {
	s, root := newTestStorage(t)
	if err := s.Mkdir(projectA, "skills", "tree/sub"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(projectA, "skills", "tree/sub/deleted-first", []byte("x"), ""); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside-tree")
	if err := os.Mkdir(outside, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(root, projectA, "skills", "tree", "sub")
	moved := filepath.Join(root, projectA, "skills", "moved-sub")
	s.runtime = &storageRuntime{hook: func(operation, stage, projectKey, relative string, body []byte) {
		if operation == "remove" && stage == "before-remove-directory" && relative == "tree/sub" {
			if err := os.Rename(sub, moved); err != nil {
				panic(err)
			}
			if err := os.Symlink(outside, sub); err != nil {
				panic(err)
			}
		}
	}}
	if err := s.Remove(projectA, "skills", "tree", true); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("replaced directory remove = %v", err)
	}
	if content, err := os.ReadFile(filepath.Join(outside, "secret")); err != nil || string(content) != "secret" {
		t.Fatalf("outside content = %q, %v", content, err)
	}
	if entries, err := os.ReadDir(moved); err != nil || len(entries) != 0 {
		t.Fatalf("partial deletion not documented by result: entries=%v err=%v", entries, err)
	}
}

func TestStorageRecursiveRemoveRejectsExternallyReplacedFile(t *testing.T) {
	s, root := newTestStorage(t)
	if err := s.Mkdir(projectA, "skills", "tree"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(projectA, "skills", "tree/file", []byte("original"), ""); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, projectA, "skills", "tree", "file")
	saved := filepath.Join(root, projectA, "skills", "saved-file")
	s.runtime = &storageRuntime{hook: func(operation, stage, projectKey, relative string, body []byte) {
		if operation == "remove" && stage == "before-remove-file" && relative == "tree/file" {
			if err := os.Rename(file, saved); err != nil {
				panic(err)
			}
			if err := os.WriteFile(file, []byte("replacement"), 0o600); err != nil {
				panic(err)
			}
		}
	}}
	if err := s.Remove(projectA, "skills", "tree", true); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("replaced file remove = %v", err)
	}
	if content, err := os.ReadFile(saved); err != nil || string(content) != "original" {
		t.Fatalf("saved content = %q, %v", content, err)
	}
	if content, err := os.ReadFile(file); err != nil || string(content) != "replacement" {
		t.Fatalf("replacement content = %q, %v", content, err)
	}
}

func TestStorageWriteReportsUncertainCommitAfterDirectorySyncFailure(t *testing.T) {
	s, _ := newTestStorage(t)
	s.runtime = &storageRuntime{fsync: func(kind string, fd int) error {
		if kind == "directory" {
			return errors.New("injected directory sync failure")
		}
		return unix.Fsync(fd)
	}}
	_, err := s.Write(projectA, "skills", "visible", []byte("committed"), "")
	if !errors.Is(err, ErrCommitUncertain) {
		t.Fatalf("write error = %v", err)
	}
	if !errors.Is(err, ErrStorage) {
		t.Fatalf("uncertain commit does not wrap storage failure: %v", err)
	}
	file, readErr := s.Read(projectA, "skills", "visible")
	if readErr != nil || string(file.Content) != "committed" {
		t.Fatalf("visible file = %q, %v", file.Content, readErr)
	}
}

func TestFileJSONDoesNotImplicitlyEncodeContent(t *testing.T) {
	body, err := json.Marshal(File{Path: "file", Content: []byte("binary")})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(body, []byte("content")) || bytes.Contains(body, []byte("YmluYXJ5")) {
		t.Fatalf("JSON exposed implicit content representation: %s", body)
	}
}

func TestStorageRejectsSymlinkProjectRoot(t *testing.T) {
	realRoot := t.TempDir()
	linkedRoot := filepath.Join(t.TempDir(), "project-root")
	if err := os.Symlink(realRoot, linkedRoot); err != nil {
		t.Fatal(err)
	}
	s := &Storage{ProjectRoot: linkedRoot, MaxFileBytes: 1024}
	if _, err := s.List(projectA, "skills", ""); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("symlink ProjectRoot = %v", err)
	}
}

func sha256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func TestStorageWriteReadListAndIsolation(t *testing.T) {
	s, _ := newTestStorage(t)
	if err := s.Mkdir(projectA, "skills", "nested"); err != nil {
		t.Fatal(err)
	}
	written, err := s.Write(projectA, "skills", "nested/tool.txt", []byte("first"), "")
	if err != nil {
		t.Fatal(err)
	}
	if written.Path != "nested/tool.txt" || written.Name != "tool.txt" || written.IsDir || written.Size != 5 || written.SHA256 == "" || !bytes.Equal(written.Content, []byte("first")) {
		t.Fatalf("unexpected written file: %+v", written)
	}
	read, err := s.Read(projectA, "skills", "nested/tool.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(read, written) {
		t.Fatalf("read = %+v, write = %+v", read, written)
	}
	entries, err := s.List(projectA, "skills", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Path != "nested" || !entries[0].IsDir {
		t.Fatalf("root entries = %+v", entries)
	}
	entries, err = s.List(projectA, "skills", ".")
	if err != nil || len(entries) != 1 {
		t.Fatalf("dot list = %+v, %v", entries, err)
	}
	if _, err := s.Read(projectB, "skills", "nested/tool.txt"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-project read error = %v", err)
	}
}

func TestStorageListIsSortedAndDoesNotExposeSymlinks(t *testing.T) {
	s, root := newTestStorage(t)
	if err := s.Mkdir(projectA, "skills", "dir"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"z.txt", "a.txt"} {
		if _, err := s.Write(projectA, "skills", "dir/"+name, []byte(name), ""); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(root, "outside")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, projectA, "skills", "dir", "link")); err != nil {
		t.Fatal(err)
	}
	entries, err := s.List(projectA, "skills", "dir")
	if !errors.Is(err, ErrUnsafePath) || entries != nil {
		t.Fatalf("list with symlink = %+v, %v", entries, err)
	}
	if err := os.Remove(filepath.Join(root, projectA, "skills", "dir", "link")); err != nil {
		t.Fatal(err)
	}
	entries, err = s.List(projectA, "skills", "dir")
	if err != nil {
		t.Fatal(err)
	}
	if got := []string{entries[0].Name, entries[1].Name}; !reflect.DeepEqual(got, []string{"a.txt", "z.txt"}) {
		t.Fatalf("order = %v", got)
	}
}

func TestStorageOptimisticConcurrencyAndAtomicReplacement(t *testing.T) {
	s, _ := newTestStorage(t)
	first, err := s.Write(projectA, "skills", "file.txt", []byte("old"), "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(projectA, "skills", "file.txt", []byte("bad"), strings.Repeat("0", 64)); !errors.Is(err, ErrConflict) {
		t.Fatalf("mismatch error = %v", err)
	}
	stillOld, err := s.Read(projectA, "skills", "file.txt")
	if err != nil || string(stillOld.Content) != "old" {
		t.Fatalf("content after conflict = %q, %v", stillOld.Content, err)
	}
	second, err := s.Write(projectA, "skills", "file.txt", []byte("new bytes"), first.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	if string(second.Content) != "new bytes" || second.SHA256 == first.SHA256 {
		t.Fatalf("replacement = %+v", second)
	}
	if _, err := s.Write(projectA, "skills", "missing.txt", []byte("x"), first.SHA256); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected hash on missing file = %v", err)
	}
}

func TestStorageMaximumFileSize(t *testing.T) {
	s, _ := newTestStorage(t)
	s.MaxFileBytes = 3
	if _, err := s.Write(projectA, "skills", "large", []byte("1234"), ""); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("large write = %v", err)
	}
	s.MaxFileBytes = 0
	if _, err := s.Write(projectA, "skills", "default-ok", []byte("small"), ""); err != nil {
		t.Fatalf("secure default rejected small file: %v", err)
	}
}

func TestStorageMkdirAndRemove(t *testing.T) {
	s, _ := newTestStorage(t)
	if err := s.Mkdir(projectA, "skills", "one/two"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(projectA, "skills", "one/two/file", []byte("x"), ""); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(projectA, "skills", "one", false); !errors.Is(err, ErrTypeConflict) {
		t.Fatalf("non-recursive non-empty remove = %v", err)
	}
	if err := s.Remove(projectA, "skills", "one/two/file", false); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(projectA, "skills", "one/two", false); err != nil {
		t.Fatal(err)
	}
	if err := s.Mkdir(projectA, "skills", "one/two"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(projectA, "skills", "one/two/file", []byte("x"), ""); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(projectA, "skills", "one", true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.List(projectA, "skills", "one"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed tree list = %v", err)
	}
	for _, rel := range []string{"", "."} {
		if err := s.Remove(projectA, "skills", rel, true); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("remove root %q = %v", rel, err)
		}
	}
}

func TestStorageRejectsInvalidScopeAndPaths(t *testing.T) {
	s, _ := newTestStorage(t)
	invalidProjects := []string{"", "project", "ws_ABCDEF00000000000000000000000000", "ws_00000000000000000000000000000001/skills"}
	for _, key := range invalidProjects {
		if _, err := s.List(key, "skills", ""); !errors.Is(err, ErrInvalidProject) {
			t.Errorf("project %q: %v", key, err)
		}
	}
	if _, err := s.List(projectA, "workspace", ""); !errors.Is(err, ErrInvalidResource) {
		t.Fatalf("resource error = %v", err)
	}
	bad := []string{"../x", "a/../x", "/absolute", "a//b", "a/./b", "a\\b", " a", "a ", "a\x00b", "a\nb"}
	for _, rel := range bad {
		if _, err := s.Write(projectA, "skills", rel, []byte("x"), ""); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("path %q: %v", rel, err)
		}
	}
	for _, rel := range []string{"", "."} {
		if _, err := s.Read(projectA, "skills", rel); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("read root %q: %v", rel, err)
		}
		if _, err := s.Write(projectA, "skills", rel, nil, ""); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("write root %q: %v", rel, err)
		}
	}
	// Storage receives URL-encoded text literally. It must not decode it into traversal.
	if _, err := s.Write(projectA, "skills", "%2e%2e", []byte("literal"), ""); err != nil {
		t.Fatalf("encoded-like literal: %v", err)
	}
}

func TestStorageRejectsMissingProjectsAndTypeConflicts(t *testing.T) {
	s, root := newTestStorage(t)
	missing := "ws_ffffffffffffffffffffffffffffffff"
	if _, err := s.List(missing, "skills", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing project = %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, projectA, "skills"), []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.Mkdir(projectA, "skills", "dir"); !errors.Is(err, ErrTypeConflict) {
		t.Fatalf("file resource root = %v", err)
	}
}

func TestStorageRejectsSymlinkParentsAndFinalTargets(t *testing.T) {
	s, root := newTestStorage(t)
	outside := filepath.Join(root, "outside")
	if err := os.Mkdir(outside, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, projectA, "skills"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, projectA, "skills", "parent")); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{
		func() error { _, err := s.Read(projectA, "skills", "parent/secret"); return err },
		func() error { _, err := s.Write(projectA, "skills", "parent/new", []byte("x"), ""); return err },
		func() error { return s.Mkdir(projectA, "skills", "parent/newdir") },
		func() error { return s.Remove(projectA, "skills", "parent/secret", true) },
	} {
		if err := operation(); !errors.Is(err, ErrUnsafePath) {
			t.Errorf("symlink parent error = %v", err)
		}
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, projectA, "skills", "final")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(projectA, "skills", "final"); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("symlink final read = %v", err)
	}
	if _, err := s.Write(projectA, "skills", "final", []byte("replacement"), ""); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("symlink final write = %v", err)
	}
	if err := s.Remove(projectA, "skills", "final", false); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("symlink final remove = %v", err)
	}
	if _, err := os.Lstat(filepath.Join(root, projectA, "skills", "final")); err != nil {
		t.Fatalf("unsafe remove changed symlink: %v", err)
	}
}

func TestStorageRejectsSymlinkProjectAndResourceDirectories(t *testing.T) {
	s, root := newTestStorage(t)
	outside := filepath.Join(root, "outside-dir")
	if err := os.Mkdir(outside, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, projectA)); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, projectA)); err != nil {
		t.Fatal(err)
	}
	if err := s.Mkdir(projectA, "skills", "dir"); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("symlink project = %v", err)
	}
	if err := os.Mkdir(filepath.Join(root, projectA+"-real"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, projectA)); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, projectA+"-real"), filepath.Join(root, projectA)); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, projectA, "skills")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.List(projectA, "skills", ""); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("symlink resource = %v", err)
	}
}
