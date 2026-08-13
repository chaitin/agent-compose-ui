// Package volumefiles resolves daemon-managed volume names to verified host
// directories beneath a configured root.
package volumefiles

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"syscall"
)

// Volume is the immutable subset of daemon volume metadata used for access
// control and path resolution. ProjectID is informational; authorization is
// deliberately based on Labels.
type Volume struct {
	Name      string
	Driver    string
	Path      string
	Labels    map[string]string
	ProjectID string
}

type VolumeInspector interface {
	InspectVolume(context.Context, string) (Volume, error)
}

type Resolver struct {
	Inspector       VolumeInspector
	Root            string
	TransactionRoot string
}

type Code string

const (
	CodeInvalid     Code = "invalid"
	CodeNotFound    Code = "not_found"
	CodeForbidden   Code = "forbidden"
	CodeUpstream    Code = "upstream"
	CodeUnavailable Code = "unavailable"
)

// Error is safe to expose at an API boundary. It never contains daemon error
// text or a physical filesystem path.
type Error struct {
	Code Code
	msg  string
}

func (e *Error) Error() string { return e.msg }
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && e.Code == t.Code
}

var (
	ErrInvalid     = &Error{Code: CodeInvalid, msg: "invalid volume request"}
	ErrNotFound    = &Error{Code: CodeNotFound, msg: "volume not found"}
	ErrForbidden   = &Error{Code: CodeForbidden, msg: "volume access forbidden"}
	ErrUpstream    = &Error{Code: CodeUpstream, msg: "volume service failure"}
	ErrUnavailable = &Error{Code: CodeUnavailable, msg: "volume service unavailable"}
)

var (
	projectKeyPattern = regexp.MustCompile(`^ws_[0-9a-f]{32}$`)
	volumeNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$`)
)

// Resolve verifies daemon ownership metadata and the filesystem boundary,
// then returns a clean configured-root-relative host path. Root's ancestors
// are deployment-trusted; Root itself and every volume-path component are
// opened with O_NOFOLLOW and must be directories.
//
// A returned string cannot pin the verified inode against a later rename.
// Callers that access it must reopen it component-by-component with no-follow
// semantics at the time of use.
func (r Resolver) Resolve(ctx context.Context, projectKey, volumeName string) (string, error) {
	if nilInterface(ctx) || nilInterface(r.Inspector) || !validRoot(r.Root) ||
		!projectKeyPattern.MatchString(projectKey) || !volumeNamePattern.MatchString(volumeName) {
		return "", ErrInvalid
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	volume, err := r.Inspector.InspectVolume(ctx, volumeName)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", ctxErr
		}
		switch {
		case errors.Is(err, context.Canceled):
			return "", context.Canceled
		case errors.Is(err, context.DeadlineExceeded):
			return "", context.DeadlineExceeded
		case errors.Is(err, ErrNotFound):
			return "", ErrNotFound
		case errors.Is(err, ErrUnavailable):
			return "", ErrUnavailable
		default:
			return "", ErrUpstream
		}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if volume.Name == "" || volume.Name != volumeName || volume.Driver != "local" ||
		volume.Labels["agent-compose-ui.managed"] != "true" ||
		volume.Labels["agent-compose-ui.project-key"] != projectKey {
		return "", ErrForbidden
	}
	if r.TransactionRoot != "" {
		rel, e := filepath.Rel(r.TransactionRoot, volume.Path)
		if e == nil && (rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
			return "", ErrForbidden
		}
	}

	components, ok := childComponents(r.Root, volume.Path)
	if !ok {
		return "", ErrForbidden
	}
	if err := verifyDirectories(ctx, r.Root, components); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", ctxErr
		}
		return "", ErrForbidden
	}
	return filepath.Join(append([]string{r.Root}, components...)...), nil
}

func nilInterface(v any) bool {
	if v == nil {
		return true
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Invalid:
		return true
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return rv.IsNil()
	default:
		return false
	}
}

func validRoot(root string) bool {
	return root != "" && filepath.IsAbs(root) && filepath.Clean(root) == root && root != string(filepath.Separator)
}

func childComponents(root, path string) ([]string, bool) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, false
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return nil, false
	}
	parts := strings.Split(rel, string(filepath.Separator))
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, false
		}
	}
	return parts, true
}

func verifyDirectories(ctx context.Context, root string, components []string) error {
	rootFD, err := syscall.Open(root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(rootFD)

	currentFD := rootFD
	defer func() {
		if currentFD != rootFD {
			_ = syscall.Close(currentFD)
		}
	}()
	for _, component := range components {
		if err := ctx.Err(); err != nil {
			return err
		}
		nextFD, err := syscall.Openat(currentFD, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		if currentFD != rootFD {
			_ = syscall.Close(currentFD)
		}
		currentFD = nextFD
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(currentFD, &stat); err != nil {
		return err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return syscall.ENOTDIR
	}
	return nil
}
