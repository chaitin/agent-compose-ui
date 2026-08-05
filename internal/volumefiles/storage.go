package volumefiles

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const (
	defaultMaxPreviewBytes int64 = 1 << 20
	defaultMaxFileBytes    int64 = 10 << 20
	MaxListEntries               = 1000
	MaxRecursiveEntries          = 10000
	MaxPathComponents            = 64
	MaxRelativePathBytes         = 4096
)

var (
	ErrInvalidPath     = errors.New("invalid path")
	ErrUnsafePath      = errors.New("unsafe path")
	ErrConflict        = errors.New("content conflict")
	ErrTypeConflict    = errors.New("resource type conflict")
	ErrTooLarge        = errors.New("file too large")
	ErrLimitExceeded   = errors.New("operation limit exceeded")
	ErrStorage         = errors.New("storage unavailable")
	ErrCommitUncertain = errors.New("commit durability uncertain")
	ErrPartialMutation = errors.New("partial mutation")
	ErrPartialWrite    = errors.New("partial write")
)

type Entry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Dir     bool   `json:"dir"`
	Size    int64  `json:"size"`
	MTimeMS int64  `json:"mtimeMs"`
	SHA256  string `json:"sha256,omitempty"`
}

type File struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	MTimeMS int64  `json:"mtimeMs"`
	SHA256  string `json:"sha256"`
	Content []byte `json:"-"`
}

type Preview struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	SHA256    string `json:"sha256"`
	Truncated bool   `json:"truncated"`
}

type Storage struct {
	MaxPreviewBytes, MaxFileBytes int64
	TransactionRoot               string
	fsyncHook                     func(int) error
	deleteHook                    func(string) error
	writeHook                     func()
	renameHook                    func(string, uint) error
	claimHook                     func()
}

func (s *Storage) openTransaction(root string, rootFD int) (int, error) {
	txn := s.TransactionRoot
	if txn == "" {
		txn = root + "-transactions"
	}
	if !filepath.IsAbs(txn) || filepath.Clean(txn) != txn {
		return -1, ErrUnsafePath
	}
	if e := unix.Mkdir(txn, 0o700); e != nil && !errors.Is(e, syscall.EEXIST) {
		return -1, ErrStorage
	}
	fd, e := unix.Open(txn, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if e != nil {
		return -1, ErrUnsafePath
	}
	var ts, rs unix.Stat_t
	if unix.Fstat(fd, &ts) != nil || unix.Fstat(rootFD, &rs) != nil || ts.Mode&0o777 != 0o700 || ts.Uid != uint32(os.Geteuid()) || ts.Dev != rs.Dev {
		unix.Close(fd)
		return -1, ErrUnsafePath
	}
	return fd, nil
}

func (s *Storage) sync(fd int) error {
	if s.fsyncHook != nil {
		return s.fsyncHook(fd)
	}
	return unix.Fsync(fd)
}

func (s *Storage) previewLimit() int64 {
	if s.MaxPreviewBytes > 0 {
		return s.MaxPreviewBytes
	}
	return defaultMaxPreviewBytes
}
func (s *Storage) fileLimit() int64 {
	if s.MaxFileBytes > 0 {
		return s.MaxFileBytes
	}
	return defaultMaxFileBytes
}

type inodeKey struct{ dev, ino uint64 }
type inodeLock struct {
	mu   sync.Mutex
	refs int
}

var volumeLocks = struct {
	sync.Mutex
	m map[inodeKey]*inodeLock
}{m: map[inodeKey]*inodeLock{}}

func lockRoot(fd int) (func(), error) {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, ErrStorage
	}
	k := inodeKey{uint64(st.Dev), st.Ino}
	volumeLocks.Lock()
	l := volumeLocks.m[k]
	if l == nil {
		l = &inodeLock{}
		volumeLocks.m[k] = l
	}
	l.refs++
	volumeLocks.Unlock()
	l.mu.Lock()
	return func() {
		l.mu.Unlock()
		volumeLocks.Lock()
		l.refs--
		if l.refs == 0 {
			delete(volumeLocks.m, k)
		}
		volumeLocks.Unlock()
	}, nil
}

func storagePath(relative string, rootOK bool) ([]string, string, error) {
	if len(relative) > MaxRelativePathBytes {
		return nil, "", ErrLimitExceeded
	}
	if relative == "" || relative == "." {
		if rootOK {
			return nil, "", nil
		}
		return nil, "", ErrInvalidPath
	}
	if !utf8.ValidString(relative) || strings.HasPrefix(relative, "/") || strings.Contains(relative, "\\") || strings.TrimSpace(relative) != relative {
		return nil, "", ErrInvalidPath
	}
	parts := strings.Split(relative, "/")
	if len(parts) > MaxPathComponents {
		return nil, "", ErrLimitExceeded
	}
	for _, p := range parts {
		if p == "" || p == "." || p == ".." || strings.TrimSpace(p) != p {
			return nil, "", ErrInvalidPath
		}
		for _, r := range p {
			if r < 0x20 || r == 0x7f {
				return nil, "", ErrInvalidPath
			}
		}
	}
	return parts, strings.Join(parts, "/"), nil
}

func openRoot(root string) (int, error) {
	if root == "" || !path.IsAbs(root) || path.Clean(root) != root || root == "/" {
		return -1, ErrUnsafePath
	}
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, ErrUnsafePath
	}
	return fd, nil
}
func dupDir(fd int) (int, error) {
	n, e := unix.Openat(fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if e != nil {
		return -1, ErrStorage
	}
	return n, nil
}

func readDirNames(fd, limit int) ([]string, error) {
	owned, err := dupDir(fd)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(owned), "directory")
	if f == nil {
		unix.Close(owned)
		return nil, ErrStorage
	}
	defer f.Close()
	names, err := f.Readdirnames(limit + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, ErrStorage
	}
	if len(names) > limit {
		return nil, ErrLimitExceeded
	}
	return names, nil
}
func walk(fd int, parts []string, create bool) (int, error) {
	cur, e := dupDir(fd)
	if e != nil {
		return -1, e
	}
	for _, p := range parts {
		n, e := unix.Openat(cur, p, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if e != nil && create && errors.Is(e, syscall.ENOENT) {
			e = unix.Mkdirat(cur, p, 0o750)
			if e == nil {
				n, e = unix.Openat(cur, p, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			}
		}
		unix.Close(cur)
		if e != nil {
			if errors.Is(e, syscall.ENOENT) {
				return -1, ErrNotFound
			}
			if errors.Is(e, syscall.ELOOP) {
				return -1, ErrUnsafePath
			}
			return -1, ErrConflict
		}
		cur = n
	}
	return cur, nil
}
func parent(fd int, parts []string, create bool) (int, string, error) {
	if len(parts) == 0 {
		return -1, "", ErrInvalidPath
	}
	p, e := walk(fd, parts[:len(parts)-1], create)
	return p, parts[len(parts)-1], e
}

func checkContext(ctx context.Context) error {
	if ctx == nil {
		return ErrInvalidPath
	}
	return ctx.Err()
}

func (s *Storage) List(ctx context.Context, root, relative string) ([]Entry, error) {
	if e := checkContext(ctx); e != nil {
		return nil, e
	}
	parts, clean, e := storagePath(relative, true)
	if e != nil {
		return nil, e
	}
	r, e := openRoot(root)
	if e != nil {
		return nil, e
	}
	defer unix.Close(r)
	d, e := walk(r, parts, false)
	if e != nil {
		return nil, e
	}
	defer unix.Close(d)
	names, e := readDirNames(d, MaxListEntries)
	if e != nil {
		return nil, e
	}
	out := make([]Entry, 0, len(names))
	for _, n := range names {
		if e := checkContext(ctx); e != nil {
			return nil, e
		}
		var st unix.Stat_t
		if unix.Fstatat(d, n, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
			return nil, ErrStorage
		}
		kind := st.Mode & unix.S_IFMT
		if kind == unix.S_IFLNK {
			return nil, ErrUnsafePath
		}
		if kind != unix.S_IFREG && kind != unix.S_IFDIR {
			return nil, ErrConflict
		}
		if kind == unix.S_IFREG && st.Nlink != 1 {
			return nil, ErrUnsafePath
		}
		p := n
		if clean != "" {
			p = clean + "/" + n
		}
		out = append(out, Entry{Name: n, Path: p, Dir: kind == unix.S_IFDIR, Size: st.Size, MTimeMS: time.Unix(st.Mtim.Sec, st.Mtim.Nsec).UnixMilli()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Storage) Read(ctx context.Context, root, relative string) (File, error) {
	if e := checkContext(ctx); e != nil {
		return File{}, e
	}
	parts, clean, e := storagePath(relative, false)
	if e != nil {
		return File{}, e
	}
	r, e := openRoot(root)
	if e != nil {
		return File{}, e
	}
	defer unix.Close(r)
	p, n, e := parent(r, parts, false)
	if e != nil {
		return File{}, e
	}
	defer unix.Close(p)
	fd, e := unix.Openat(p, n, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if e != nil {
		if errors.Is(e, syscall.ENOENT) {
			return File{}, ErrNotFound
		}
		return File{}, ErrUnsafePath
	}
	f := os.NewFile(uintptr(fd), n)
	if f == nil {
		unix.Close(fd)
		return File{}, ErrStorage
	}
	defer f.Close()
	var st unix.Stat_t
	if unix.Fstat(fd, &st) != nil {
		return File{}, ErrStorage
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return File{}, ErrConflict
	}
	if st.Nlink != 1 {
		return File{}, ErrUnsafePath
	}
	if st.Size > s.fileLimit() {
		return File{}, ErrTooLarge
	}
	b, e := io.ReadAll(io.LimitReader(f, s.fileLimit()+1))
	if e != nil {
		return File{}, ErrStorage
	}
	if int64(len(b)) > s.fileLimit() {
		return File{}, ErrTooLarge
	}
	sum := sha256.Sum256(b)
	return File{Path: clean, Size: int64(len(b)), MTimeMS: time.Unix(st.Mtim.Sec, st.Mtim.Nsec).UnixMilli(), SHA256: hex.EncodeToString(sum[:]), Content: b}, nil
}

func (s *Storage) Preview(ctx context.Context, root, relative string) (Preview, error) {
	f, e := s.Read(ctx, root, relative)
	if e != nil {
		return Preview{}, e
	}
	if !utf8.Valid(f.Content) {
		return Preview{}, ErrConflict
	}
	limit := s.previewLimit()
	n := int64(len(f.Content))
	if n > limit {
		n = limit
		for n > 0 && !utf8.RuneStart(f.Content[n]) {
			n--
		}
	}
	return Preview{Path: f.Path, Content: string(f.Content[:n]), SHA256: f.SHA256, Truncated: n < int64(len(f.Content))}, nil
}

func validSHA(v string) bool {
	if v == "" {
		return true
	}
	if len(v) != 64 {
		return false
	}
	for _, c := range v {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func sameInode(a, b unix.Stat_t) bool { return a.Dev == b.Dev && a.Ino == b.Ino }
func safeRegular(st unix.Stat_t, max int64) bool {
	return st.Mode&unix.S_IFMT == unix.S_IFREG && st.Nlink == 1 && st.Size <= max
}
func (s *Storage) rename2(stage string, oldFD int, old string, newFD int, new string, flags uint) error {
	if s.renameHook != nil {
		if e := s.renameHook(stage, flags); e != nil {
			if errors.Is(e, syscall.ENOSYS) || errors.Is(e, syscall.EINVAL) {
				return ErrStorage
			}
			return e
		}
	}
	e := unix.Renameat2(oldFD, old, newFD, new, flags)
	if errors.Is(e, syscall.ENOSYS) || errors.Is(e, syscall.EINVAL) {
		return ErrStorage
	}
	return e
}
func hashAt(parent int, name string, max int64) (string, error) {
	fd, e := unix.Openat(parent, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if e != nil {
		return "", ErrUnsafePath
	}
	f := os.NewFile(uintptr(fd), name)
	if f == nil {
		unix.Close(fd)
		return "", ErrStorage
	}
	defer f.Close()
	var st unix.Stat_t
	if unix.Fstat(fd, &st) != nil || !safeRegular(st, max) {
		return "", ErrUnsafePath
	}
	b, e := io.ReadAll(io.LimitReader(f, max+1))
	if e != nil || int64(len(b)) > max {
		return "", ErrStorage
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func (s *Storage) Write(ctx context.Context, root, relative string, body []byte, expected string) (File, error) {
	if e := checkContext(ctx); e != nil {
		return File{}, e
	}
	if int64(len(body)) > s.fileLimit() {
		return File{}, ErrTooLarge
	}
	if !validSHA(expected) {
		return File{}, ErrInvalidPath
	}
	parts, clean, e := storagePath(relative, false)
	if e != nil {
		return File{}, e
	}
	r, e := openRoot(root)
	if e != nil {
		return File{}, e
	}
	defer unix.Close(r)
	unlock, e := lockRoot(r)
	if e != nil {
		return File{}, e
	}
	defer unlock()
	if e := checkContext(ctx); e != nil {
		return File{}, e
	}
	txnFD, e := s.openTransaction(root, r)
	if e != nil {
		return File{}, e
	}
	defer unix.Close(txnFD)
	p, n, e := parent(r, parts, true)
	if e != nil {
		return File{}, e
	}
	defer unix.Close(p)
	var before unix.Stat_t
	targetExists := true
	if e = unix.Fstatat(p, n, &before, unix.AT_SYMLINK_NOFOLLOW); errors.Is(e, syscall.ENOENT) {
		targetExists = false
	} else if e != nil {
		return File{}, ErrStorage
	}
	if targetExists {
		if before.Mode&unix.S_IFMT != unix.S_IFREG {
			return File{}, ErrTypeConflict
		}
		if before.Nlink != 1 {
			return File{}, ErrUnsafePath
		}
		if before.Size > s.fileLimit() {
			return File{}, ErrTooLarge
		}
	}
	if expected != "" {
		if !targetExists {
			return File{}, ErrConflict
		}
		fd, e := unix.Openat(p, n, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
		if e != nil {
			return File{}, ErrConflict
		}
		old := os.NewFile(uintptr(fd), n)
		var opened unix.Stat_t
		if unix.Fstat(fd, &opened) != nil || opened.Mode&unix.S_IFMT != unix.S_IFREG || opened.Nlink != 1 || opened.Size > s.fileLimit() || opened.Dev != before.Dev || opened.Ino != before.Ino {
			old.Close()
			return File{}, ErrUnsafePath
		}
		b, e := io.ReadAll(io.LimitReader(old, s.fileLimit()+1))
		old.Close()
		if e != nil {
			return File{}, ErrStorage
		}
		sum := sha256.Sum256(b)
		if hex.EncodeToString(sum[:]) != expected {
			return File{}, ErrConflict
		}
	}
	var rb [8]byte
	if _, e = rand.Read(rb[:]); e != nil {
		return File{}, ErrStorage
	}
	tmp := ".volume-upload-" + hex.EncodeToString(rb[:])
	fd, e := unix.Openat(txnFD, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if e != nil {
		return File{}, ErrStorage
	}
	cleanup := true
	f := os.NewFile(uintptr(fd), tmp)
	if f == nil {
		unix.Close(fd)
		_ = unix.Unlinkat(txnFD, tmp, 0)
		return File{}, ErrStorage
	}
	defer func() {
		_ = f.Close()
		if cleanup {
			_ = unix.Unlinkat(txnFD, tmp, 0)
		}
	}()
	if _, e = f.Write(body); e != nil {
		return File{}, ErrStorage
	}
	if e = s.sync(fd); e != nil {
		return File{}, ErrStorage
	}
	if e = f.Close(); e != nil {
		return File{}, ErrStorage
	}
	var ours unix.Stat_t
	if unix.Fstatat(txnFD, tmp, &ours, unix.AT_SYMLINK_NOFOLLOW) != nil || !safeRegular(ours, s.fileLimit()) {
		return File{}, ErrStorage
	}
	committed := false
	for attempt := 0; attempt < 3 && !committed; attempt++ {
		if s.writeHook != nil {
			s.writeHook()
		}
		if !targetExists {
			e = s.rename2("noreplace", txnFD, tmp, p, n, unix.RENAME_NOREPLACE)
			if e == nil {
				cleanup = false
				committed = true
				break
			}
			if errors.Is(e, syscall.EEXIST) {
				if unix.Fstatat(p, n, &before, unix.AT_SYMLINK_NOFOLLOW) != nil {
					return File{}, ErrStorage
				}
				targetExists = true
				continue
			}
			return File{}, ErrStorage
		}
		e = s.rename2("exchange", txnFD, tmp, p, n, unix.RENAME_EXCHANGE)
		if errors.Is(e, syscall.ENOENT) {
			if expected != "" {
				return File{}, ErrConflict
			}
			targetExists = false
			continue
		}
		if e != nil {
			return File{}, ErrStorage
		}
		cleanup = false
		var newTarget, displaced unix.Stat_t
		if unix.Fstatat(p, n, &newTarget, unix.AT_SYMLINK_NOFOLLOW) != nil || unix.Fstatat(txnFD, tmp, &displaced, unix.AT_SYMLINK_NOFOLLOW) != nil || !sameInode(newTarget, ours) {
			return File{}, ErrPartialWrite
		}
		if !safeRegular(displaced, s.fileLimit()) {
			return File{}, ErrPartialWrite
		}
		if !sameInode(displaced, before) {
			return File{}, ErrPartialWrite
		}
		if expected != "" {
			sum, e := hashAt(txnFD, tmp, s.fileLimit())
			if e != nil || !sameInode(displaced, before) || sum != expected {
				return File{}, ErrPartialWrite
			}
		}
		var still unix.Stat_t
		if unix.Fstatat(txnFD, tmp, &still, unix.AT_SYMLINK_NOFOLLOW) != nil || !sameInode(still, displaced) {
			return File{}, ErrPartialWrite
		}
		if e = unix.Unlinkat(txnFD, tmp, 0); e != nil {
			return File{}, ErrCommitUncertain
		}
		committed = true
	}
	if !committed {
		return File{}, ErrStorage
	}
	if e = s.sync(txnFD); e != nil {
		return File{}, ErrCommitUncertain
	}
	if e = s.sync(p); e != nil {
		return File{}, ErrCommitUncertain
	}
	sum := sha256.Sum256(body)
	var st unix.Stat_t
	if unix.Fstatat(p, n, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
		return File{}, ErrCommitUncertain
	}
	return File{Path: clean, Size: int64(len(body)), MTimeMS: time.Unix(st.Mtim.Sec, st.Mtim.Nsec).UnixMilli(), SHA256: hex.EncodeToString(sum[:])}, nil
}

func (s *Storage) Mkdir(ctx context.Context, root, relative string) error {
	if e := checkContext(ctx); e != nil {
		return e
	}
	parts, _, e := storagePath(relative, false)
	if e != nil {
		return e
	}
	r, e := openRoot(root)
	if e != nil {
		return e
	}
	defer unix.Close(r)
	u, e := lockRoot(r)
	if e != nil {
		return e
	}
	defer u()
	cur, e := dupDir(r)
	if e != nil {
		return e
	}
	defer unix.Close(cur)
	for _, part := range parts {
		if e := checkContext(ctx); e != nil {
			return e
		}
		next, openErr := unix.Openat(cur, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if errors.Is(openErr, syscall.ENOENT) {
			if e = unix.Mkdirat(cur, part, 0o750); e != nil {
				return ErrStorage
			}
			if e = s.sync(cur); e != nil {
				return ErrCommitUncertain
			}
			next, openErr = unix.Openat(cur, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		}
		if openErr != nil {
			return ErrTypeConflict
		}
		unix.Close(cur)
		cur = next
	}
	return nil
}

func preflightTree(ctx context.Context, fd, depth int, count *int) error {
	if depth > MaxPathComponents {
		return ErrLimitExceeded
	}
	remaining := MaxRecursiveEntries - *count
	if remaining < 0 {
		return ErrLimitExceeded
	}
	names, e := readDirNames(fd, remaining)
	if e != nil {
		return e
	}
	*count += len(names)
	for _, n := range names {
		if e := checkContext(ctx); e != nil {
			return e
		}
		var st unix.Stat_t
		if unix.Fstatat(fd, n, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
			return ErrStorage
		}
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFREG:
			if st.Nlink != 1 {
				return ErrUnsafePath
			}
		case unix.S_IFDIR:
			d, e := unix.Openat(fd, n, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if e != nil {
				return ErrUnsafePath
			}
			e = preflightTree(ctx, d, depth+1, count)
			unix.Close(d)
			if e != nil {
				return e
			}
		default:
			return ErrUnsafePath
		}
	}
	return nil
}

func partialDelete(err error, removed bool) error {
	if removed {
		return fmt.Errorf("%w: %v", ErrPartialMutation, err)
	}
	return err
}

func (s *Storage) removeTree(ctx context.Context, fd int, count *int, removed *bool) error {
	remaining := MaxRecursiveEntries - *count
	if remaining < 0 {
		return partialDelete(ErrLimitExceeded, *removed)
	}
	names, e := readDirNames(fd, remaining)
	if e != nil {
		return partialDelete(e, *removed)
	}
	if len(names)+*count > MaxRecursiveEntries {
		return partialDelete(ErrLimitExceeded, *removed)
	}
	*count += len(names)
	for _, n := range names {
		if e := checkContext(ctx); e != nil {
			return partialDelete(e, *removed)
		}
		var st unix.Stat_t
		if unix.Fstatat(fd, n, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
			return partialDelete(ErrStorage, *removed)
		}
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFDIR:
			d, e := unix.Openat(fd, n, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if e != nil {
				return partialDelete(ErrUnsafePath, *removed)
			}
			e = s.removeTree(ctx, d, count, removed)
			unix.Close(d)
			if e != nil {
				return e
			}
			if unix.Unlinkat(fd, n, unix.AT_REMOVEDIR) != nil {
				return partialDelete(ErrConflict, *removed)
			}
			*removed = true
		case unix.S_IFREG:
			if st.Nlink != 1 {
				return partialDelete(ErrUnsafePath, *removed)
			}
			if s.deleteHook != nil {
				if e := s.deleteHook(n); e != nil {
					return partialDelete(ErrStorage, *removed)
				}
			}
			if unix.Unlinkat(fd, n, 0) != nil {
				return partialDelete(ErrConflict, *removed)
			}
			*removed = true
		default:
			return partialDelete(ErrUnsafePath, *removed)
		}
	}
	return nil
}

func (s *Storage) RemoveFile(ctx context.Context, root, relative string) error {
	return s.remove(ctx, root, relative, false, 1)
}

func (s *Storage) RemoveFolder(ctx context.Context, root, relative string, recursive bool) error {
	return s.remove(ctx, root, relative, recursive, 2)
}

// Remove remains for storage-level compatibility and removes either exact
// object type. HTTP callers use the type-specific methods above.
func (s *Storage) Remove(ctx context.Context, root, relative string, recursive bool) error {
	return s.remove(ctx, root, relative, recursive, 0)
}

func (s *Storage) remove(ctx context.Context, root, relative string, recursive bool, requiredType int) error {
	if e := checkContext(ctx); e != nil {
		return e
	}
	parts, _, e := storagePath(relative, false)
	if e != nil {
		return e
	}
	r, e := openRoot(root)
	if e != nil {
		return e
	}
	defer unix.Close(r)
	u, e := lockRoot(r)
	if e != nil {
		return e
	}
	defer u()
	p, n, e := parent(r, parts, false)
	if e != nil {
		return e
	}
	defer unix.Close(p)
	var st unix.Stat_t
	if e = unix.Fstatat(p, n, &st, unix.AT_SYMLINK_NOFOLLOW); e != nil {
		return ErrNotFound
	}
	kind := st.Mode & unix.S_IFMT
	if requiredType == 1 && kind != unix.S_IFREG || requiredType == 2 && kind != unix.S_IFDIR {
		return ErrTypeConflict
	}
	if kind == unix.S_IFREG && st.Nlink != 1 {
		return ErrUnsafePath
	}
	if kind != unix.S_IFREG && kind != unix.S_IFDIR {
		return ErrUnsafePath
	}
	preflightCount := 0
	if kind == unix.S_IFDIR {
		d, x := unix.Openat(p, n, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if x != nil {
			return ErrUnsafePath
		}
		if recursive {
			x = preflightTree(ctx, d, len(parts), &preflightCount)
		} else {
			names, readErr := readDirNames(d, 0)
			if readErr != nil || len(names) > 0 {
				x = ErrConflict
			}
		}
		unix.Close(d)
		if x != nil {
			return x
		}
	}
	txnFD, e := s.openTransaction(root, r)
	if e != nil {
		return e
	}
	defer unix.Close(txnFD)
	var rb [8]byte
	if _, e = rand.Read(rb[:]); e != nil {
		return ErrStorage
	}
	artifact := ".volume-delete-" + hex.EncodeToString(rb[:])
	if s.claimHook != nil {
		s.claimHook()
	}
	if e = s.rename2("claim", p, n, txnFD, artifact, unix.RENAME_NOREPLACE); e != nil {
		if errors.Is(e, syscall.ENOENT) {
			return ErrNotFound
		}
		return ErrStorage
	}
	var claimed unix.Stat_t
	if unix.Fstatat(txnFD, artifact, &claimed, unix.AT_SYMLINK_NOFOLLOW) != nil || !sameInode(claimed, st) {
		return ErrPartialMutation
	}
	if kind == unix.S_IFREG {
		// Deletion is not a content read/write operation: file size is not a
		// safety boundary. The atomic claim already proved inode identity; only
		// the regular-file and single-link invariants apply here.
		if claimed.Mode&unix.S_IFMT != unix.S_IFREG || claimed.Nlink != 1 {
			return ErrPartialMutation
		}
		if e = unix.Unlinkat(txnFD, artifact, 0); e != nil {
			return ErrPartialMutation
		}
	} else {
		d, x := unix.Openat(txnFD, artifact, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if x != nil {
			return ErrPartialMutation
		}
		if recursive {
			count := 0
			x = preflightTree(ctx, d, len(parts), &count)
			if x == nil {
				count = 0
				removed := false
				x = s.removeTree(ctx, d, &count, &removed)
			}
		}
		unix.Close(d)
		if x != nil {
			return ErrPartialMutation
		}
		if e = unix.Unlinkat(txnFD, artifact, unix.AT_REMOVEDIR); e != nil {
			return ErrPartialMutation
		}
	}
	if e = s.sync(txnFD); e != nil {
		if recursive && preflightCount > 0 {
			return ErrPartialMutation
		}
		return ErrCommitUncertain
	}
	if e = s.sync(p); e != nil {
		if recursive && preflightCount > 0 {
			return ErrPartialMutation
		}
		return ErrCommitUncertain
	}
	return nil
}
