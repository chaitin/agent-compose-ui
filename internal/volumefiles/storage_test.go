package volumefiles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestStorageListPreviewWriteAndRemove(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "b.txt"), []byte("bravo"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("alphabet"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := &Storage{MaxPreviewBytes: 3, MaxFileBytes: 32}
	entries, err := s.List(context.Background(), root, "")
	if err != nil || len(entries) != 2 || entries[0].Name != "a.txt" {
		t.Fatalf("List = %#v, %v", entries, err)
	}
	p, err := s.Preview(context.Background(), root, "a.txt")
	want := sha256.Sum256([]byte("alphabet"))
	if err != nil || p.Content != "alp" || !p.Truncated || p.SHA256 != hex.EncodeToString(want[:]) {
		t.Fatalf("Preview = %#v, %v", p, err)
	}
	f, err := s.Write(context.Background(), root, "a.txt", []byte("new"), p.SHA256)
	if err != nil || f.Size != 3 {
		t.Fatalf("Write = %#v, %v", f, err)
	}
	if _, err := s.Write(context.Background(), root, "a.txt", []byte("lost"), p.SHA256); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale Write error = %v", err)
	}
	if err := s.Mkdir(context.Background(), root, "dir/sub"); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(context.Background(), root, "dir", false); !errors.Is(err, ErrConflict) {
		t.Fatalf("nonrecursive Remove = %v", err)
	}
	if err := s.Remove(context.Background(), root, "dir", true); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentConditionalWritesSerialize(t *testing.T) {
	root := t.TempDir()
	s := &Storage{}
	f, err := s.Write(context.Background(), root, "value", []byte("old"), "")
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, value := range []string{"one", "two"} {
		wg.Add(1)
		go func(v string) {
			defer wg.Done()
			<-start
			_, e := s.Write(context.Background(), root, "value", []byte(v), f.SHA256)
			errs <- e
		}(value)
	}
	close(start)
	wg.Wait()
	close(errs)
	success, conflict := 0, 0
	for e := range errs {
		if e == nil {
			success++
		} else if errors.Is(e, ErrConflict) {
			conflict++
		} else {
			t.Fatalf("error = %v", e)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success/conflict = %d/%d", success, conflict)
	}
	volumeLocks.Lock()
	remaining := len(volumeLocks.m)
	volumeLocks.Unlock()
	if remaining != 0 {
		t.Fatalf("lock leak: %d", remaining)
	}
}

func TestMutationLockCoordinatesDistinctDescriptorsForSameVolumeInode(t *testing.T) {
	root := t.TempDir()
	a, err := openRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(a)
	b, err := openRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(b)
	unlockA, err := lockRoot(a)
	if err != nil {
		t.Fatal(err)
	}
	acquired := make(chan func(), 1)
	go func() {
		unlock, err := lockRoot(b)
		if err != nil {
			acquired <- nil
			return
		}
		acquired <- unlock
	}()
	select {
	case <-acquired:
		t.Fatal("alias lock did not block")
	case <-time.After(20 * time.Millisecond):
	}
	unlockA()
	select {
	case unlock := <-acquired:
		if unlock == nil {
			t.Fatal("alias lock failed")
		}
		unlock()
	case <-time.After(time.Second):
		t.Fatal("alias lock did not acquire")
	}
}

func TestStorageRejectsUnixSocket(t *testing.T) {
	root := t.TempDir()
	socket := filepath.Join(root, "sock")
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	s := &Storage{}
	if _, err = s.List(context.Background(), root, ""); err == nil {
		t.Fatal("List socket succeeded")
	}
	if _, err = s.Read(context.Background(), root, "sock"); err == nil {
		t.Fatal("Read socket succeeded")
	}
	if err = s.RemoveFile(context.Background(), root, "sock"); err == nil {
		t.Fatal("Remove socket succeeded")
	}
	if _, err = os.Lstat(socket); err != nil {
		t.Fatalf("socket mutated: %v", err)
	}
}

func TestStorageListLimitBoundary(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < MaxListEntries+1; i++ {
		name := filepath.Join(root, fmt.Sprintf("%04d", i))
		if err := os.WriteFile(name, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := (&Storage{}).List(context.Background(), root, ""); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("List = %v", err)
	}
}

func TestConcurrentConditionalWriteAndRemoveHaveValidOrdering(t *testing.T) {
	for iteration := 0; iteration < 20; iteration++ {
		root := t.TempDir()
		s := &Storage{}
		f, err := s.Write(context.Background(), root, "value", []byte("old"), "")
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		results := make(chan error, 2)
		go func() {
			<-start
			_, e := s.Write(context.Background(), root, "value", []byte("new"), f.SHA256)
			results <- e
		}()
		go func() { <-start; results <- s.RemoveFile(context.Background(), root, "value") }()
		close(start)
		a, b := <-results, <-results
		valid := a == nil && b == nil || a == nil && errors.Is(b, ErrConflict) || b == nil && errors.Is(a, ErrConflict)
		if !valid {
			t.Fatalf("iteration %d errors = %v, %v", iteration, a, b)
		}
	}
	volumeLocks.Lock()
	remaining := len(volumeLocks.m)
	volumeLocks.Unlock()
	if remaining != 0 {
		t.Fatalf("lock leak: %d", remaining)
	}
}

func TestStorageCanceledWriteLeavesNoTemporaryFile(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&Storage{}).Write(ctx, root, "value", []byte("x"), ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("Write = %v", err)
	}
	names, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Fatalf("left files: %#v", names)
	}
}

func TestStoragePathDepthBoundary(t *testing.T) {
	root := t.TempDir()
	parts := make([]string, MaxPathComponents+1)
	for i := range parts {
		parts[i] = "d"
	}
	if err := (&Storage{}).Mkdir(context.Background(), root, strings.Join(parts, "/")); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("Mkdir = %v", err)
	}
}

func TestStorageRecursiveRemoveLimitIsCheckedBeforeMutation(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "tree")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < MaxRecursiveEntries+1; i++ {
		f, err := os.Create(filepath.Join(dir, fmt.Sprintf("%05d", i)))
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
	if err := (&Storage{}).RemoveFolder(context.Background(), root, "tree", true); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("RemoveFolder = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "00000")); err != nil {
		t.Fatalf("tree partially mutated: %v", err)
	}
}

func TestReadDirNamesDoesNotTakeOwnershipOfCallerFD(t *testing.T) {
	fd, err := unix.Open(t.TempDir(), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	if _, err := readDirNames(fd, 10); err != nil {
		t.Fatal(err)
	}
	runtime.GC()
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		t.Fatalf("caller fd was closed: %v", err)
	}
}

func TestStorageRejectsUnsafeObjectsAndPaths(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(root, "hard")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(root, "fifo"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := &Storage{}
	for _, name := range []string{"../outside", "/etc/passwd", `a\\b`, "link", "hard", "fifo"} {
		if _, err := s.Read(context.Background(), root, name); err == nil {
			t.Errorf("Read(%q) succeeded", name)
		}
	}
}

func TestStorageRejectsReplacedRoot(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "volume")
	outside := t.TempDir()
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(root, root+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, root); err != nil {
		t.Fatal(err)
	}
	if _, err := (&Storage{}).List(context.Background(), root, ""); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("List error = %v", err)
	}
}

func TestStorageHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&Storage{}).List(ctx, t.TempDir(), ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("List error = %v", err)
	}
}

func TestStorageRemoveRequiresExactType(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	s := &Storage{}
	if err := s.RemoveFile(context.Background(), root, "dir"); !errors.Is(err, ErrTypeConflict) {
		t.Fatalf("RemoveFile(dir) = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "dir")); err != nil {
		t.Fatalf("directory mutated: %v", err)
	}
	if err := s.RemoveFolder(context.Background(), root, "file", false); !errors.Is(err, ErrTypeConflict) {
		t.Fatalf("RemoveFolder(file) = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "file")); err != nil {
		t.Fatalf("file mutated: %v", err)
	}
	if err := s.RemoveFile(context.Background(), root, "file"); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveFolder(context.Background(), root, "dir", false); err != nil {
		t.Fatal(err)
	}
}

func TestUnconditionalWriteRejectsExistingUnsafeLeafWithoutMutation(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(root, "hard")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(root, "fifo"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"link", "hard", "dir", "fifo"} {
		if _, err := (&Storage{}).Write(context.Background(), root, name, []byte("new"), ""); err == nil {
			t.Errorf("Write(%s) succeeded", name)
		}
	}
	b, err := os.ReadFile(outside)
	if err != nil || string(b) != "secret" {
		t.Fatalf("outside=%q,%v", b, err)
	}
}

func TestUnconditionalWriteRejectsLeafSwapAfterClassification(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := &Storage{writeHook: func() {
		if err := os.Remove(target); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, target); err != nil {
			t.Fatal(err)
		}
	}}
	if _, err := s.Write(context.Background(), root, "target", []byte("new"), ""); !errors.Is(err, ErrPartialWrite) {
		t.Fatalf("Write=%v", err)
	}
	b, _ := os.ReadFile(outside)
	if string(b) != "secret" {
		t.Fatalf("outside=%q", b)
	}
}

func TestAtomicWriteHandlesExternalLeafRaces(t *testing.T) {
	t.Run("absent-appearance-safe", func(t *testing.T) {
		root := t.TempDir()
		target := filepath.Join(root, "target")
		once := sync.Once{}
		s := &Storage{writeHook: func() {
			once.Do(func() {
				if err := os.WriteFile(target, []byte("external"), 0o600); err != nil {
					t.Fatal(err)
				}
			})
		}}
		if _, err := s.Write(context.Background(), root, "target", []byte("ours"), ""); err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(target)
		if string(b) != "ours" {
			t.Fatalf("target=%q", b)
		}
	})
	t.Run("cas-regular-swap-rolls-back", func(t *testing.T) {
		root := t.TempDir()
		target := filepath.Join(root, "target")
		s := &Storage{}
		f, err := s.Write(context.Background(), root, "target", []byte("old"), "")
		if err != nil {
			t.Fatal(err)
		}
		once := sync.Once{}
		s.writeHook = func() {
			once.Do(func() {
				if err := os.WriteFile(filepath.Join(root, "replacement"), []byte("external"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(filepath.Join(root, "replacement"), target); err != nil {
					t.Fatal(err)
				}
			})
		}
		if _, err = s.Write(context.Background(), root, "target", []byte("ours"), f.SHA256); !errors.Is(err, ErrPartialWrite) {
			t.Fatalf("Write=%v", err)
		}
		b, _ := os.ReadFile(target)
		if string(b) != "ours" {
			t.Fatalf("published state: %q", b)
		}
	})
	t.Run("rollback-failure-partial", func(t *testing.T) {
		root := t.TempDir()
		target := filepath.Join(root, "target")
		outside := filepath.Join(t.TempDir(), "outside")
		os.WriteFile(target, []byte("old"), 0o600)
		os.WriteFile(outside, []byte("secret"), 0o600)
		once := sync.Once{}
		s := &Storage{writeHook: func() { once.Do(func() { os.Remove(target); os.Symlink(outside, target) }) }, renameHook: func(stage string, _ uint) error {
			if stage == "rollback" {
				return syscall.EIO
			}
			return nil
		}}
		if _, err := s.Write(context.Background(), root, "target", []byte("ours"), ""); !errors.Is(err, ErrPartialWrite) {
			t.Fatalf("Write=%v", err)
		}
		b, _ := os.ReadFile(outside)
		if string(b) != "secret" {
			t.Fatalf("outside=%q", b)
		}
	})
}

func TestAtomicWriteRollsBackUnsafeExternalAppearances(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "target")
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
				t.Fatal(err)
			}
			once := sync.Once{}
			s := &Storage{writeHook: func() {
				once.Do(func() {
					switch kind {
					case "symlink":
						if err := os.Symlink(outside, target); err != nil {
							t.Fatal(err)
						}
					case "hardlink":
						if err := os.Link(outside, target); err != nil {
							t.Fatal(err)
						}
					case "fifo":
						if err := syscall.Mkfifo(target, 0o600); err != nil {
							t.Fatal(err)
						}
					}
				})
			}}
			if _, err := s.Write(context.Background(), root, "target", []byte("ours"), ""); err == nil {
				t.Fatal("Write succeeded")
			}
			b, _ := os.ReadFile(outside)
			if string(b) != "secret" {
				t.Fatalf("outside=%q", b)
			}
			entries, _ := os.ReadDir(root)
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".volume-upload-") {
					t.Fatalf("temp leaked: %s", entry.Name())
				}
			}
		})
	}
}

func TestAtomicWriteFailsClosedWhenRenameat2Unsupported(t *testing.T) {
	root := t.TempDir()
	s := &Storage{renameHook: func(string, uint) error { return syscall.ENOSYS }}
	if _, err := s.Write(context.Background(), root, "target", []byte("ours"), ""); !errors.Is(err, ErrStorage) {
		t.Fatalf("Write=%v", err)
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 0 {
		t.Fatalf("left entries=%v", entries)
	}
}

func TestWriteUsesPrivateTransactionRootAndCleansSuccess(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "volume")
	txn := filepath.Join(parent, "transactions")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	s := &Storage{TransactionRoot: txn}
	if _, err := s.Write(context.Background(), root, "target", []byte("one"), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(context.Background(), root, "target", []byte("two"), ""); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(txn)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("transaction artifacts=%v", entries)
	}
	info, _ := os.Stat(txn)
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("mode=%o", info.Mode().Perm())
	}
}

func TestWriteMismatchRetainsPrivateArtifactAndReportsPartialWrite(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "volume")
	txn := filepath.Join(parent, "transactions")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	once := sync.Once{}
	s := &Storage{TransactionRoot: txn, writeHook: func() {
		once.Do(func() {
			replacement := filepath.Join(root, "replacement")
			os.WriteFile(replacement, []byte("attacker"), 0o600)
			os.Rename(replacement, target)
		})
	}}
	if _, err := s.Write(context.Background(), root, "target", []byte("ours"), ""); !errors.Is(err, ErrPartialWrite) {
		t.Fatalf("Write=%v", err)
	}
	b, _ := os.ReadFile(target)
	if string(b) != "ours" {
		t.Fatalf("published=%q", b)
	}
	entries, _ := os.ReadDir(txn)
	if len(entries) != 1 {
		t.Fatalf("retained artifacts=%v", entries)
	}
	artifact, _ := os.ReadFile(filepath.Join(txn, entries[0].Name()))
	if string(artifact) != "attacker" {
		t.Fatalf("artifact=%q", artifact)
	}
}

func TestWriteRejectsSymlinkTransactionRoot(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "volume")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(parent, "real")
	os.Mkdir(real, 0o700)
	txn := filepath.Join(parent, "transactions")
	os.Symlink(real, txn)
	if _, err := (&Storage{TransactionRoot: txn}).Write(context.Background(), root, "target", []byte("x"), ""); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("Write=%v", err)
	}
}

func TestWriteRejectsPermissiveTransactionRoot(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "volume")
	txn := filepath.Join(parent, "transactions")
	os.Mkdir(root, 0o700)
	os.Mkdir(txn, 0o755)
	if _, err := (&Storage{TransactionRoot: txn}).Write(context.Background(), root, "target", []byte("x"), ""); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("Write=%v", err)
	}
}

func TestMkdirFsyncFailureIsCommitUncertain(t *testing.T) {
	root := t.TempDir()
	calls := 0
	s := &Storage{fsyncHook: func(int) error { calls++; return syscall.EIO }}
	err := s.Mkdir(context.Background(), root, "created/child")
	if !errors.Is(err, ErrCommitUncertain) {
		t.Fatalf("Mkdir=%v", err)
	}
	if calls != 1 {
		t.Fatalf("fsync calls=%d", calls)
	}
	if _, statErr := os.Stat(filepath.Join(root, "created")); statErr != nil {
		t.Fatalf("visible directory missing: %v", statErr)
	}
}

func TestRecursivePreflightRejectsDeepLimitBeforeMutation(t *testing.T) {
	root := t.TempDir()
	cur := filepath.Join(root, "tree")
	if err := os.Mkdir(cur, 0o700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < MaxPathComponents; i++ {
		cur = filepath.Join(cur, "d")
		if err := os.Mkdir(cur, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	marker := filepath.Join(root, "tree", "marker")
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	err := (&Storage{}).RemoveFolder(context.Background(), root, "tree", true)
	if !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("RemoveFolder=%v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("preflight mutated tree: %v", err)
	}
}

func TestRecursiveDeleteReportsPartialMutationAfterDeletionStarts(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "tree")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"a", "b"} {
		if err := os.WriteFile(filepath.Join(dir, n), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	calls := 0
	s := &Storage{deleteHook: func(string) error {
		calls++
		if calls == 2 {
			return syscall.EIO
		}
		return nil
	}}
	err := s.RemoveFolder(context.Background(), root, "tree", true)
	if !errors.Is(err, ErrPartialMutation) {
		t.Fatalf("RemoveFolder=%v", err)
	}
	artifacts, readErr := os.ReadDir(root + "-transactions")
	if readErr != nil {
		t.Fatal(readErr)
	}
	if len(artifacts) != 1 {
		t.Fatalf("artifacts=%v", artifacts)
	}
	entries, readErr := os.ReadDir(filepath.Join(root+"-transactions", artifacts[0].Name()))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if len(entries) != 1 {
		t.Fatalf("remaining=%d", len(entries))
	}
}

func TestDirectDeleteSyncFailureIsCommitUncertain(t *testing.T) {
	for _, kind := range []string{"file", "folder"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "target")
			if kind == "file" {
				if err := os.WriteFile(target, nil, 0o600); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Mkdir(target, 0o700); err != nil {
				t.Fatal(err)
			}
			s := &Storage{fsyncHook: func(int) error { return syscall.EIO }}
			var err error
			if kind == "file" {
				err = s.RemoveFile(context.Background(), root, "target")
			} else {
				err = s.RemoveFolder(context.Background(), root, "target", false)
			}
			if !errors.Is(err, ErrCommitUncertain) {
				t.Fatalf("Remove=%v", err)
			}
			if _, statErr := os.Stat(target); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("target still visible: %v", statErr)
			}
		})
	}
}

func TestRemoveFileClaimsExactLeafAndNeverDeletesReplacement(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "volume")
	txn := filepath.Join(parent, "transactions")
	os.Mkdir(root, 0o700)
	target := filepath.Join(root, "target")
	os.WriteFile(target, []byte("original"), 0o600)
	once := sync.Once{}
	s := &Storage{TransactionRoot: txn, claimHook: func() {
		once.Do(func() {
			replacement := filepath.Join(root, "replacement")
			os.WriteFile(replacement, []byte("replacement"), 0o600)
			os.Rename(replacement, target)
		})
	}}
	if err := s.RemoveFile(context.Background(), root, "target"); !errors.Is(err, ErrPartialMutation) {
		t.Fatalf("RemoveFile=%v", err)
	}
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("volume target changed: %v", err)
	}
	entries, _ := os.ReadDir(txn)
	if len(entries) != 1 {
		t.Fatalf("artifacts=%v", entries)
	}
	b, _ := os.ReadFile(filepath.Join(txn, entries[0].Name()))
	if string(b) != "replacement" {
		t.Fatalf("artifact=%q", b)
	}
}

func TestRemoveFileAllowsOversizedRegularFile(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "large")
	f, err := os.Create(target)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Truncate(defaultMaxFileBytes + 1); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()
	if err := (&Storage{}).RemoveFile(context.Background(), root, "large"); err != nil {
		t.Fatalf("RemoveFile=%v", err)
	}
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("target remains: %v", err)
	}
}

func TestRemoveFolderDoesNotDeleteReplacementName(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "volume")
	txn := filepath.Join(parent, "transactions")
	os.Mkdir(root, 0o700)
	target := filepath.Join(root, "target")
	os.Mkdir(target, 0o700)
	os.WriteFile(filepath.Join(target, "old"), nil, 0o600)
	once := sync.Once{}
	s := &Storage{TransactionRoot: txn, claimHook: func() { once.Do(func() { os.Rename(target, filepath.Join(root, "moved")); os.Mkdir(target, 0o700) }) }}
	if err := s.RemoveFolder(context.Background(), root, "target", true); !errors.Is(err, ErrPartialMutation) {
		t.Fatalf("RemoveFolder=%v", err)
	}
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("replacement name unexpectedly present: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "moved", "old")); err != nil {
		t.Fatalf("original changed: %v", err)
	}
	entries, _ := os.ReadDir(txn)
	if len(entries) != 1 {
		t.Fatalf("retained artifacts=%v", entries)
	}
	info, err := os.Stat(filepath.Join(txn, entries[0].Name()))
	if err != nil || !info.IsDir() {
		t.Fatalf("replacement artifact=%v", err)
	}
}

func TestRecursiveDeleteSyncFailureAfterChildrenIsPartial(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "tree")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	s := &Storage{fsyncHook: func(int) error { return syscall.EIO }}
	if err := s.RemoveFolder(context.Background(), root, "tree", true); !errors.Is(err, ErrPartialMutation) {
		t.Fatalf("Remove=%v", err)
	}
}
