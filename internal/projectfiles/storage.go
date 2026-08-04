// Package projectfiles stores project-scoped resource files without following
// symbolic links beneath the configured project root.
package projectfiles

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	defaultMaxFileBytes int64 = 10 << 20
	// MaxListEntries bounds memory used by one List call. Write and Mkdir may
	// grow a namespace beyond this point; subsequent List fails explicitly.
	MaxListEntries = 1_000
	// MaxRecursiveEntries bounds work performed by one recursive Remove. Write
	// and Mkdir do not enforce this traversal quota at creation time.
	MaxRecursiveEntries = 10_000
	// MaxPathComponents limits path traversal depth for every public operation.
	MaxPathComponents = 64
	// MaxRelativePathBytes bounds raw UTF-8 path input before component counting,
	// allocation, or filesystem calls. It is compatible with HTTP request paths.
	MaxRelativePathBytes = 4_096
)

var (
	ErrInvalidProject  = errors.New("invalid project")
	ErrInvalidResource = errors.New("invalid resource")
	ErrInvalidPath     = errors.New("invalid path")
	ErrInvalidChecksum = errors.New("invalid checksum")
	ErrUnsafePath      = errors.New("unsafe path")
	ErrNotFound        = errors.New("not found")
	ErrConflict        = errors.New("content conflict")
	ErrTooLarge        = errors.New("file too large")
	ErrTypeConflict    = errors.New("file type conflict")
	ErrStorage         = errors.New("storage unavailable")
	ErrLimitExceeded   = errors.New("storage operation limit exceeded")
	// ErrCommitUncertain means rename succeeded but durable directory sync did
	// not. The replacement may already be visible and must not be blindly retried.
	// Error mappers must classify this before ErrStorage because it intentionally
	// wraps an ErrStorage cause while requiring different retry semantics.
	ErrCommitUncertain = errors.New("commit durability uncertain")
)

var projectKeyPattern = regexp.MustCompile(`^ws_[0-9a-f]{32}$`)

// Namespace mutation serialization.

type namespaceLock struct {
	mu   sync.Mutex
	refs int
}

type namespaceLockManager struct {
	mu    sync.Mutex
	locks map[namespaceKey]*namespaceLock
}

type namespaceKey struct {
	device     uint64
	inode      uint64
	projectKey string
	resource   string
}

var namespaceLocks = namespaceLockManager{locks: make(map[namespaceKey]*namespaceLock)}

func (m *namespaceLockManager) lock(key namespaceKey, queued func()) func() {
	m.mu.Lock()
	entry := m.locks[key]
	if entry == nil {
		entry = &namespaceLock{}
		m.locks[key] = entry
	}
	entry.refs++
	m.mu.Unlock()

	if queued != nil {
		queued()
	}
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		m.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(m.locks, key)
		}
		m.mu.Unlock()
	}
}

func namespaceKeyForRoot(rootFD int, projectKey, resource string) (namespaceKey, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(rootFD, &stat); err != nil {
		return namespaceKey{}, storageError(ErrStorage, "identify project namespace", err)
	}
	return namespaceKey{device: uint64(stat.Dev), inode: stat.Ino, projectKey: projectKey, resource: resource}, nil
}

// Error classifies failures for a future transport layer without exposing host
// paths. Kind is one of the exported sentinel errors above. Callers mapping via
// errors.Is must test ErrCommitUncertain before ErrStorage.
type Error struct {
	Kind error
	Op   string
	Err  error
}

func (e *Error) Error() string {
	if e.Op == "" {
		return e.Kind.Error()
	}
	return e.Op + ": " + e.Kind.Error()
}

func (e *Error) Unwrap() error { return e.Err }
func (e *Error) Is(target error) bool {
	return target == e.Kind || errors.Is(e.Err, target)
}

func storageError(kind error, op string, err error) error {
	return &Error{Kind: kind, Op: op, Err: err}
}

// Storage configuration and per-instance runtime controls.

type Storage struct {
	ProjectRoot  string
	MaxFileBytes int64
	runtime      *storageRuntime
}

// storageRuntime is immutable after a Storage begins use. Keeping it behind a
// pointer makes copying Storage safe: copies share the same read-only limits
// and hooks. Production instances leave it nil and use conservative defaults.
type storageRuntime struct {
	listLimit       int
	removeLimit     int
	pathLimit       int
	hook            func(operation, stage, projectKey, relative string, body []byte)
	fsync           func(kind string, fd int) error
	verifyCommitted func(parent int, name string, device, inode uint64) error
}

func (s *Storage) callHook(operation, stage, projectKey, relative string, body []byte) {
	if s.runtime != nil && s.runtime.hook != nil {
		s.runtime.hook(operation, stage, projectKey, relative, body)
	}
}

func (s *Storage) listLimit() int {
	if s.runtime != nil && s.runtime.listLimit > 0 {
		return s.runtime.listLimit
	}
	return MaxListEntries
}

func (s *Storage) removeLimit() int {
	if s.runtime != nil && s.runtime.removeLimit > 0 {
		return s.runtime.removeLimit
	}
	return MaxRecursiveEntries
}

func (s *Storage) pathLimit() int {
	if s.runtime != nil && s.runtime.pathLimit > 0 {
		return s.runtime.pathLimit
	}
	return MaxPathComponents
}

func (s *Storage) sync(kind string, fd int) error {
	if s.runtime != nil && s.runtime.fsync != nil {
		return s.runtime.fsync(kind, fd)
	}
	return unix.Fsync(fd)
}

func (s *Storage) verifyCommittedFile(parent int, name string, device, inode uint64) error {
	if s.runtime != nil && s.runtime.verifyCommitted != nil {
		return s.runtime.verifyCommitted(parent, name, device, inode)
	}
	var target unix.Stat_t
	if err := unix.Fstatat(parent, name, &target, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return classifyAtError(parent, name, "verify committed file", err)
	}
	if device != uint64(target.Dev) || inode != target.Ino {
		return storageError(ErrUnsafePath, "verify committed file", nil)
	}
	return nil
}

func validChecksum(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for i := range len(value) {
		if !((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f')) {
			return false
		}
	}
	return true
}

func (s *Storage) maxBytes() int64 {
	if s.MaxFileBytes <= 0 {
		return defaultMaxFileBytes
	}
	return s.MaxFileBytes
}

func boundedReadLimit(maxBytes int64) int64 {
	if maxBytes == math.MaxInt64 {
		return math.MaxInt64
	}
	return maxBytes + 1
}

func validateScope(projectKey, resource string) error {
	if !projectKeyPattern.MatchString(projectKey) {
		return storageError(ErrInvalidProject, "validate project", nil)
	}
	if resource != "skills" {
		return storageError(ErrInvalidResource, "validate resource", nil)
	}
	return nil
}

func validatePath(relative string, allowRoot bool, maxComponents int) ([]string, string, error) {
	if len(relative) > MaxRelativePathBytes {
		return nil, "", storageError(ErrLimitExceeded, "validate path bytes", nil)
	}
	if relative == "" || relative == "." {
		if allowRoot {
			return nil, "", nil
		}
		return nil, "", storageError(ErrInvalidPath, "validate path", nil)
	}
	if strings.HasPrefix(relative, "/") || strings.Contains(relative, "\\") || strings.TrimSpace(relative) != relative {
		return nil, "", storageError(ErrInvalidPath, "validate path", nil)
	}
	if strings.Count(relative, "/")+1 > maxComponents {
		return nil, "", storageError(ErrLimitExceeded, "validate path", nil)
	}
	parts := strings.Split(relative, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.TrimSpace(part) != part {
			return nil, "", storageError(ErrInvalidPath, "validate path", nil)
		}
		for _, r := range part {
			if r == 0 || r < 0x20 || r == 0x7f {
				return nil, "", storageError(ErrInvalidPath, "validate path", nil)
			}
		}
	}
	return parts, strings.Join(parts, "/"), nil
}

// Descriptor-confined path traversal.

func dupFD(fd int) (int, error) {
	// Reopen the directory instead of dup(2): duplicated descriptors share a
	// directory-stream offset, which would make independent List/Remove walks
	// consume one another's entries.
	return unix.Openat(fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
}

func classifyAtError(parent int, name, op string, err error) error {
	if errors.Is(err, syscall.ENOENT) {
		return storageError(ErrNotFound, op, err)
	}
	var stat unix.Stat_t
	if unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW) == nil && stat.Mode&unix.S_IFMT == unix.S_IFLNK {
		return storageError(ErrUnsafePath, op, err)
	}
	if errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.EISDIR) || errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST) {
		return storageError(ErrTypeConflict, op, err)
	}
	if errors.Is(err, syscall.ELOOP) {
		return storageError(ErrUnsafePath, op, err)
	}
	return storageError(ErrStorage, op, err)
}

func openDirAt(parent int, name string, create bool) (int, error) {
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err == nil {
		return fd, nil
	}
	if create && errors.Is(err, syscall.ENOENT) {
		if mkdirErr := unix.Mkdirat(parent, name, 0o750); mkdirErr != nil && !errors.Is(mkdirErr, syscall.EEXIST) {
			return -1, classifyAtError(parent, name, "create directory", mkdirErr)
		}
		fd, err = unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err == nil {
			return fd, nil
		}
	}
	return -1, classifyAtError(parent, name, "open directory", err)
}

func (s *Storage) openProjectRoot() (int, error) {
	// ProjectRoot is trusted configuration, but it must name a real directory,
	// not a symlink. Its parent components remain deployment authority.
	root, err := unix.Open(s.ProjectRoot, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		if info, inspectErr := os.Lstat(s.ProjectRoot); inspectErr == nil && info.Mode()&os.ModeSymlink != 0 {
			return -1, storageError(ErrUnsafePath, "open project storage", err)
		}
		return -1, storageError(ErrStorage, "open project storage", err)
	}
	return root, nil
}

func openResourceAt(rootFD int, projectKey, resource string, create bool) (int, error) {
	project, err := openDirAt(rootFD, projectKey, false)
	if err != nil {
		return -1, err
	}
	defer unix.Close(project)
	return openDirAt(project, resource, create)
}

func (s *Storage) openResource(projectKey, resource string, create bool) (int, error) {
	if err := validateScope(projectKey, resource); err != nil {
		return -1, err
	}
	root, err := s.openProjectRoot()
	if err != nil {
		return -1, err
	}
	defer unix.Close(root)
	return openResourceAt(root, projectKey, resource, create)
}

func walkDirs(start int, parts []string, create bool) (int, error) {
	current, err := dupFD(start)
	if err != nil {
		return -1, storageError(ErrStorage, "duplicate directory", err)
	}
	for _, part := range parts {
		next, openErr := openDirAt(current, part, create)
		unix.Close(current)
		if openErr != nil {
			return -1, openErr
		}
		current = next
	}
	return current, nil
}

func openParent(resourceFD int, parts []string, create bool) (int, string, error) {
	if len(parts) == 0 {
		return -1, "", storageError(ErrInvalidPath, "open parent", nil)
	}
	parent, err := walkDirs(resourceFD, parts[:len(parts)-1], create)
	return parent, parts[len(parts)-1], err
}

func fileFromFD(fd int, relative string, maxBytes int64) (File, error) {
	f := os.NewFile(uintptr(fd), path.Base(relative))
	if f == nil {
		unix.Close(fd)
		return File{}, storageError(ErrStorage, "open file", nil)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return File{}, storageError(ErrStorage, "inspect file", err)
	}
	if !info.Mode().IsRegular() {
		return File{}, storageError(ErrTypeConflict, "read file", nil)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Nlink != 1 {
		return File{}, storageError(ErrUnsafePath, "read file", nil)
	}
	content, err := io.ReadAll(io.LimitReader(f, boundedReadLimit(maxBytes)))
	if err != nil {
		return File{}, storageError(ErrStorage, "read file", err)
	}
	if int64(len(content)) > maxBytes {
		return File{}, storageError(ErrTooLarge, "read file", nil)
	}
	sum := sha256.Sum256(content)
	return File{Path: relative, Name: path.Base(relative), Size: info.Size(), ModTime: info.ModTime(), SHA256: hex.EncodeToString(sum[:]), Content: content}, nil
}

func (s *Storage) Read(projectKey, resource, relative string) (File, error) {
	parts, clean, err := validatePath(relative, false, s.pathLimit())
	if err != nil {
		return File{}, err
	}
	resourceFD, err := s.openResource(projectKey, resource, false)
	if err != nil {
		return File{}, err
	}
	defer unix.Close(resourceFD)
	parent, name, err := openParent(resourceFD, parts, false)
	if err != nil {
		return File{}, err
	}
	defer unix.Close(parent)
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return File{}, classifyAtError(parent, name, "open file", err)
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		unix.Close(fd)
		return File{}, storageError(ErrStorage, "inspect file", err)
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		unix.Close(fd)
		return File{}, storageError(ErrTypeConflict, "read file", nil)
	}
	if stat.Size > s.maxBytes() {
		unix.Close(fd)
		return File{}, storageError(ErrTooLarge, "read file", nil)
	}
	return fileFromFD(fd, clean, s.maxBytes())
}

func (s *Storage) List(projectKey, resource, relative string) ([]Entry, error) {
	parts, clean, err := validatePath(relative, true, s.pathLimit())
	if err != nil {
		return nil, err
	}
	resourceFD, err := s.openResource(projectKey, resource, false)
	if err != nil {
		return nil, err
	}
	defer unix.Close(resourceFD)
	dirFD, err := walkDirs(resourceFD, parts, false)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dirFD)
	names, err := readDirNames(dirFD, s.listLimit())
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(names))
	for _, name := range names {
		var stat unix.Stat_t
		if err := unix.Fstatat(dirFD, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return nil, classifyAtError(dirFD, name, "inspect directory entry", err)
		}
		kind := stat.Mode & unix.S_IFMT
		if kind == unix.S_IFLNK {
			return nil, storageError(ErrUnsafePath, "list directory", nil)
		}
		if kind != unix.S_IFDIR && kind != unix.S_IFREG {
			return nil, storageError(ErrUnsafePath, "list directory", nil)
		}
		if kind == unix.S_IFREG && stat.Nlink != 1 {
			return nil, storageError(ErrUnsafePath, "list directory", nil)
		}
		rel := name
		if clean != "" {
			rel = clean + "/" + rel
		}
		entries = append(entries, Entry{Path: rel, Name: name, IsDir: kind == unix.S_IFDIR, Size: stat.Size, ModTime: time.Unix(stat.Mtim.Sec, stat.Mtim.Nsec)})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries, nil
}

// Bounded directory enumeration.

func readDirNames(fd, limit int) ([]string, error) {
	if _, err := unix.Seek(fd, 0, io.SeekStart); err != nil {
		return nil, storageError(ErrStorage, "rewind directory", err)
	}
	buffer := make([]byte, 8192)
	var names []string
	for {
		n, err := unix.ReadDirent(fd, buffer)
		if err != nil {
			return nil, storageError(ErrStorage, "read directory", err)
		}
		if n == 0 {
			return names, nil
		}
		_, _, names = unix.ParseDirent(buffer[:n], limit+1-len(names), names)
		if len(names) > limit {
			return nil, storageError(ErrLimitExceeded, "read directory", nil)
		}
	}
}

func currentHash(parent int, name string) (string, bool, error) {
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if errors.Is(err, syscall.ENOENT) {
		return "", false, nil
	}
	if err != nil {
		return "", false, classifyAtError(parent, name, "inspect current file", err)
	}
	f := os.NewFile(uintptr(fd), name)
	if f == nil {
		unix.Close(fd)
		return "", false, storageError(ErrStorage, "inspect current file", nil)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", false, storageError(ErrStorage, "inspect current file", err)
	}
	if !info.Mode().IsRegular() {
		return "", false, storageError(ErrTypeConflict, "inspect current file", nil)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Nlink != 1 {
		return "", false, storageError(ErrUnsafePath, "inspect current file", nil)
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", false, storageError(ErrStorage, "inspect current file", err)
	}
	return hex.EncodeToString(h.Sum(nil)), true, nil
}

func checkExpected(parent int, name, expected string) error {
	if expected == "" {
		return nil
	}
	actual, exists, err := currentHash(parent, name)
	if err != nil {
		return err
	}
	if !exists || actual != expected {
		return storageError(ErrConflict, "write file", nil)
	}
	return nil
}

func validateWriteTarget(parent int, name string) error {
	var stat unix.Stat_t
	err := unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if err != nil {
		return classifyAtError(parent, name, "inspect write target", err)
	}
	switch stat.Mode & unix.S_IFMT {
	case unix.S_IFLNK:
		return storageError(ErrUnsafePath, "write file", nil)
	case unix.S_IFREG:
		if stat.Nlink != 1 {
			return storageError(ErrUnsafePath, "write file", nil)
		}
		return nil
	default:
		return storageError(ErrTypeConflict, "write file", nil)
	}
}

func tempName() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return ".projectfiles-" + hex.EncodeToString(value[:]) + ".tmp", nil
}

func (s *Storage) writeFileAt(parent int, name, clean, projectKey string, body []byte, expectedSHA256 string) (File, bool, error) {
	if err := validateWriteTarget(parent, name); err != nil {
		return File{}, false, err
	}
	if err := checkExpected(parent, name, expectedSHA256); err != nil {
		return File{}, false, err
	}
	tmp, err := tempName()
	if err != nil {
		return File{}, false, storageError(ErrStorage, "create temporary file", err)
	}
	fd, err := unix.Openat(parent, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o640)
	if err != nil {
		return File{}, false, classifyAtError(parent, tmp, "create temporary file", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = unix.Unlinkat(parent, tmp, 0)
		}
	}()
	f := os.NewFile(uintptr(fd), tmp)
	if f == nil {
		unix.Close(fd)
		return File{}, false, storageError(ErrStorage, "create temporary file", nil)
	}
	defer f.Close()
	if _, err := f.Write(body); err != nil {
		return File{}, false, storageError(ErrStorage, "write temporary file", err)
	}
	if err := s.sync("file", int(f.Fd())); err != nil {
		return File{}, false, storageError(ErrStorage, "sync temporary file", err)
	}
	if err := checkExpected(parent, name, expectedSHA256); err != nil {
		return File{}, false, err
	}
	s.callHook("write", "after-expected", projectKey, clean, body)
	tempInfo, err := f.Stat()
	if err != nil {
		return File{}, false, storageError(ErrStorage, "inspect temporary file", err)
	}
	tempStat, ok := tempInfo.Sys().(*syscall.Stat_t)
	if !ok || !tempInfo.Mode().IsRegular() || tempStat.Nlink != 1 {
		return File{}, false, storageError(ErrUnsafePath, "inspect temporary file", nil)
	}
	if err := unix.Renameat(parent, tmp, parent, name); err != nil {
		return File{}, false, classifyAtError(parent, name, "replace file", err)
	}
	cleanup = false
	if err := s.verifyCommittedFile(parent, name, uint64(tempStat.Dev), tempStat.Ino); err != nil {
		return File{}, true, storageError(ErrCommitUncertain, "verify committed file", err)
	}
	if err := s.sync("directory", parent); err != nil {
		return File{}, true, storageError(ErrCommitUncertain, "sync committed directory", storageError(ErrStorage, "sync directory", err))
	}
	sum := sha256.Sum256(body)
	return File{Path: clean, Name: path.Base(clean), Size: tempInfo.Size(), ModTime: tempInfo.ModTime(), SHA256: hex.EncodeToString(sum[:]), Content: append([]byte(nil), body...)}, true, nil
}

// Atomic writes and namespace mutation operations.

func (s *Storage) Write(projectKey, resource, relative string, body []byte, expectedSHA256 string) (File, error) {
	if int64(len(body)) > s.maxBytes() {
		return File{}, storageError(ErrTooLarge, "write file", nil)
	}
	parts, clean, err := validatePath(relative, false, s.pathLimit())
	if err != nil {
		return File{}, err
	}
	if err := validateScope(projectKey, resource); err != nil {
		return File{}, err
	}
	if expectedSHA256 != "" && !validChecksum(expectedSHA256) {
		return File{}, storageError(ErrInvalidChecksum, "write file", nil)
	}
	rootFD, err := s.openProjectRoot()
	if err != nil {
		return File{}, err
	}
	defer unix.Close(rootFD)
	key, err := namespaceKeyForRoot(rootFD, projectKey, resource)
	if err != nil {
		return File{}, err
	}
	s.callHook("write", "before-lock", projectKey, clean, body)
	// All mutations through this package in one project resource serialize. This
	// makes expected-hash validation through rename/fsync atomic relative to
	// Write, Mkdir, and direct or ancestor Remove. Host-side mutation remains
	// outside the gateway API's authority; descriptor-based path safety remains.
	unlock := namespaceLocks.lock(key, func() {
		s.callHook("write", "queued", projectKey, clean, body)
	})
	locked := true
	defer func() {
		if locked {
			unlock()
		}
	}()
	resourceFD, err := openResourceAt(rootFD, projectKey, resource, true)
	if err != nil {
		return File{}, err
	}
	defer unix.Close(resourceFD)
	parent, name, err := openParent(resourceFD, parts, false)
	if err != nil {
		return File{}, err
	}
	defer unix.Close(parent)
	committed, _, err := s.writeFileAt(parent, name, clean, projectKey, body, expectedSHA256)
	if err != nil {
		return File{}, err
	}
	unlock()
	locked = false
	s.callHook("write", "after-rename", projectKey, clean, body)
	return committed, nil
}

// CreateDirectoryFile atomically claims a new directory name and creates its
// initial file while holding the namespace mutation lock.
func (s *Storage) CreateDirectoryFile(projectKey, resource, directory, fileName string, body []byte) (File, error) {
	if int64(len(body)) > s.maxBytes() {
		return File{}, storageError(ErrTooLarge, "create directory file", nil)
	}
	dirParts, cleanDir, err := validatePath(directory, false, s.pathLimit())
	if err != nil {
		return File{}, err
	}
	fileParts, cleanFile, err := validatePath(fileName, false, 1)
	if err != nil || len(fileParts) != 1 {
		return File{}, storageError(ErrInvalidPath, "validate initial file", err)
	}
	if err := validateScope(projectKey, resource); err != nil {
		return File{}, err
	}
	rootFD, err := s.openProjectRoot()
	if err != nil {
		return File{}, err
	}
	defer unix.Close(rootFD)
	key, err := namespaceKeyForRoot(rootFD, projectKey, resource)
	if err != nil {
		return File{}, err
	}
	unlock := namespaceLocks.lock(key, nil)
	defer unlock()
	resourceFD, err := openResourceAt(rootFD, projectKey, resource, true)
	if err != nil {
		return File{}, err
	}
	defer unix.Close(resourceFD)
	parent, name, err := openParent(resourceFD, dirParts, false)
	if err != nil {
		return File{}, err
	}
	defer unix.Close(parent)
	if err := unix.Mkdirat(parent, name, 0o750); err != nil {
		if errors.Is(err, syscall.EEXIST) {
			var existing unix.Stat_t
			if inspectErr := unix.Fstatat(parent, name, &existing, unix.AT_SYMLINK_NOFOLLOW); inspectErr != nil {
				return File{}, classifyAtError(parent, name, "inspect skill collision", inspectErr)
			}
			switch existing.Mode & unix.S_IFMT {
			case unix.S_IFDIR:
				return File{}, storageError(ErrConflict, "create skill directory", err)
			case unix.S_IFREG:
				if existing.Nlink == 1 {
					return File{}, storageError(ErrConflict, "create skill directory", err)
				}
				return File{}, storageError(ErrUnsafePath, "create skill directory", err)
			default:
				return File{}, storageError(ErrUnsafePath, "create skill directory", err)
			}
		}
		return File{}, classifyAtError(parent, name, "create skill directory", err)
	}
	dirFD, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		_ = unix.Unlinkat(parent, name, unix.AT_REMOVEDIR)
		return File{}, classifyAtError(parent, name, "open created directory", err)
	}
	defer unix.Close(dirFD)
	var createdStat unix.Stat_t
	if err := unix.Fstat(dirFD, &createdStat); err != nil {
		_ = unix.Unlinkat(parent, name, unix.AT_REMOVEDIR)
		return File{}, storageError(ErrStorage, "identify created directory", err)
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		var current unix.Stat_t
		if unix.Fstatat(parent, name, &current, unix.AT_SYMLINK_NOFOLLOW) == nil && sameFileIdentity(&createdStat, &current) {
			_ = unix.Unlinkat(parent, name, unix.AT_REMOVEDIR)
		}
	}()
	fullPath := cleanDir + "/" + cleanFile
	file, fileCommitted, err := s.writeFileAt(dirFD, fileParts[0], fullPath, projectKey, body, "")
	committed = fileCommitted
	if err != nil {
		return File{}, err
	}
	if err := s.sync("directory", parent); err != nil {
		committed = true
		return File{}, storageError(ErrCommitUncertain, "sync created directory", storageError(ErrStorage, "sync directory", err))
	}
	committed = true
	return file, nil
}

func (s *Storage) Mkdir(projectKey, resource, relative string) error {
	parts, clean, err := validatePath(relative, true, s.pathLimit())
	if err != nil {
		return err
	}
	if err := validateScope(projectKey, resource); err != nil {
		return err
	}
	rootFD, err := s.openProjectRoot()
	if err != nil {
		return err
	}
	defer unix.Close(rootFD)
	key, err := namespaceKeyForRoot(rootFD, projectKey, resource)
	if err != nil {
		return err
	}
	unlock := namespaceLocks.lock(key, func() {
		s.callHook("mkdir", "queued", projectKey, clean, nil)
	})
	defer unlock()
	resourceFD, err := openResourceAt(rootFD, projectKey, resource, true)
	if err != nil {
		return err
	}
	defer unix.Close(resourceFD)
	dir, err := walkDirs(resourceFD, parts, true)
	if err != nil {
		return err
	}
	if err := unix.Close(dir); err != nil {
		return storageError(ErrStorage, "close created directory", err)
	}
	return nil
}

func sameFileIdentity(left, right *unix.Stat_t) bool {
	return left.Dev == right.Dev && left.Ino == right.Ino
}

func revalidateRemovalEntry(parent int, name string, original *unix.Stat_t, wantKind uint32) error {
	var current unix.Stat_t
	if err := unix.Fstatat(parent, name, &current, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return classifyAtError(parent, name, "revalidate removal entry", err)
	}
	if current.Mode&unix.S_IFMT != wantKind || !sameFileIdentity(original, &current) {
		return storageError(ErrUnsafePath, "revalidate removal entry", nil)
	}
	if wantKind == unix.S_IFREG && current.Nlink != 1 {
		return storageError(ErrUnsafePath, "revalidate removal entry", nil)
	}
	return nil
}

func (s *Storage) removeTree(fd int, projectKey, relative string, depth int, remaining *int) error {
	names, err := readDirNames(fd, *remaining)
	if err != nil {
		return err
	}
	for _, name := range names {
		if depth+1 > s.pathLimit() {
			return storageError(ErrLimitExceeded, "remove directory depth", nil)
		}
		if *remaining == 0 {
			return storageError(ErrLimitExceeded, "remove directory", nil)
		}
		*remaining--
		var stat unix.Stat_t
		if err := unix.Fstatat(fd, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return classifyAtError(fd, name, "inspect removal entry", err)
		}
		kind := stat.Mode & unix.S_IFMT
		entryPath := name
		if relative != "" {
			entryPath = relative + "/" + name
		}
		if kind == unix.S_IFLNK || (kind != unix.S_IFDIR && kind != unix.S_IFREG) {
			return storageError(ErrUnsafePath, "remove directory", nil)
		}
		if kind == unix.S_IFREG && stat.Nlink != 1 {
			return storageError(ErrUnsafePath, "remove directory", nil)
		}
		if kind == unix.S_IFDIR {
			child, err := openDirAt(fd, name, false)
			if err != nil {
				return err
			}
			var opened unix.Stat_t
			if err := unix.Fstat(child, &opened); err != nil {
				unix.Close(child)
				return storageError(ErrStorage, "inspect opened removal directory", err)
			}
			if !sameFileIdentity(&stat, &opened) {
				unix.Close(child)
				return storageError(ErrUnsafePath, "open removal directory", nil)
			}
			err = s.removeTree(child, projectKey, entryPath, depth+1, remaining)
			closeErr := unix.Close(child)
			if err != nil {
				return err
			}
			if closeErr != nil {
				return storageError(ErrStorage, "close removal directory", closeErr)
			}
			s.callHook("remove", "before-remove-directory", projectKey, entryPath, nil)
			if err := revalidateRemovalEntry(fd, name, &stat, unix.S_IFDIR); err != nil {
				return err
			}
			if err := unix.Unlinkat(fd, name, unix.AT_REMOVEDIR); err != nil {
				return classifyAtError(fd, name, "remove directory", err)
			}
		} else {
			s.callHook("remove", "before-remove-file", projectKey, entryPath, nil)
			if err := revalidateRemovalEntry(fd, name, &stat, unix.S_IFREG); err != nil {
				return err
			}
			if err := unix.Unlinkat(fd, name, 0); err != nil {
				return classifyAtError(fd, name, "remove file", err)
			}
		}
	}
	return nil
}

// Remove serializes with API mutations in the same project resource. External
// host writers are not coordinated: recursive removal is a bounded depth-first
// pass, not a snapshot or all-or-nothing transaction. It may safely delete a
// prefix before failing closed when an entry is replaced or becomes unsafe.
func (s *Storage) Remove(projectKey, resource, relative string, recursive bool) error {
	parts, clean, err := validatePath(relative, false, s.pathLimit())
	if err != nil {
		return err
	}
	if err := validateScope(projectKey, resource); err != nil {
		return err
	}
	rootFD, err := s.openProjectRoot()
	if err != nil {
		return err
	}
	defer unix.Close(rootFD)
	key, err := namespaceKeyForRoot(rootFD, projectKey, resource)
	if err != nil {
		return err
	}
	unlock := namespaceLocks.lock(key, func() {
		s.callHook("remove", "queued", projectKey, clean, nil)
	})
	defer unlock()
	resourceFD, err := openResourceAt(rootFD, projectKey, resource, false)
	if err != nil {
		return err
	}
	defer unix.Close(resourceFD)
	parent, name, err := openParent(resourceFD, parts, false)
	if err != nil {
		return err
	}
	defer unix.Close(parent)
	var stat unix.Stat_t
	if err := unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return classifyAtError(parent, name, "inspect removal target", err)
	}
	switch stat.Mode & unix.S_IFMT {
	case unix.S_IFLNK:
		return storageError(ErrUnsafePath, "remove path", nil)
	case unix.S_IFREG:
		if stat.Nlink != 1 {
			return storageError(ErrUnsafePath, "remove path", nil)
		}
		s.callHook("remove", "before-remove-file", projectKey, clean, nil)
		if err := revalidateRemovalEntry(parent, name, &stat, unix.S_IFREG); err != nil {
			return err
		}
		if err := unix.Unlinkat(parent, name, 0); err != nil {
			return classifyAtError(parent, name, "remove file", err)
		}
		return nil
	case unix.S_IFDIR:
		if !recursive {
			s.callHook("remove", "before-remove-directory", projectKey, clean, nil)
			if err := revalidateRemovalEntry(parent, name, &stat, unix.S_IFDIR); err != nil {
				return err
			}
			if err := unix.Unlinkat(parent, name, unix.AT_REMOVEDIR); err != nil {
				return classifyAtError(parent, name, "remove directory", err)
			}
			return nil
		}
		target, err := openDirAt(parent, name, false)
		if err != nil {
			return err
		}
		var opened unix.Stat_t
		if err := unix.Fstat(target, &opened); err != nil {
			unix.Close(target)
			return storageError(ErrStorage, "inspect opened removal target", err)
		}
		if !sameFileIdentity(&stat, &opened) {
			unix.Close(target)
			return storageError(ErrUnsafePath, "open removal target", nil)
		}
		remaining := s.removeLimit()
		removeErr := s.removeTree(target, projectKey, clean, len(parts), &remaining)
		closeErr := unix.Close(target)
		if removeErr != nil {
			return removeErr
		}
		if closeErr != nil {
			return storageError(ErrStorage, "close removal target", closeErr)
		}
		s.callHook("remove", "before-remove-directory", projectKey, clean, nil)
		if err := revalidateRemovalEntry(parent, name, &stat, unix.S_IFDIR); err != nil {
			return err
		}
		if err := unix.Unlinkat(parent, name, unix.AT_REMOVEDIR); err != nil {
			return classifyAtError(parent, name, "remove directory", err)
		}
		return nil
	default:
		return storageError(ErrUnsafePath, "remove path", nil)
	}
}
