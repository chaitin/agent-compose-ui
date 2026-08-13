package sharedirs

import (
	"encoding/json"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxCatalogBytes = 1 << 20
	maxEntries      = 256
	maxIDLength     = 64
	maxNameLength   = 256
	maxPathLength   = 4096
)

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)

// Entry describes an administrator-approved shared directory capability.
// Paths are lexical guardrails for trusted, single-administrator configuration;
// this package never resolves, opens, or mounts them. Consumers must select
// entries by ID and call ValidateSelection at their trust boundary. Deployment
// or mount authorities remain responsible for symlink and bind-mount resolution.
type Entry struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	Writable bool   `json:"writable"`
}

func ParseCatalog(raw string) ([]Entry, error) {
	if strings.TrimSpace(raw) == "" {
		return []Entry{}, nil
	}
	if !utf8.ValidString(raw) {
		return nil, fmt.Errorf("catalog must contain valid UTF-8")
	}
	if len(raw) > maxCatalogBytes {
		return nil, fmt.Errorf("catalog is too large")
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	token, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("invalid catalog JSON: %w", err)
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '[' {
		return nil, fmt.Errorf("catalog must be a JSON array")
	}
	entries := make([]Entry, 0)
	for dec.More() {
		if len(entries) >= maxEntries {
			return nil, fmt.Errorf("catalog has too many entries")
		}
		entry, err := decodeEntry(dec)
		if err != nil {
			return nil, fmt.Errorf("catalog entry %d: %w", len(entries), err)
		}
		entries = append(entries, entry)
	}
	if _, err := dec.Token(); err != nil {
		return nil, fmt.Errorf("invalid catalog JSON: %w", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("catalog must contain exactly one JSON value")
	}
	if err := validateCatalog(entries); err != nil {
		return nil, err
	}
	return entries, nil
}

func decodeEntry(dec *json.Decoder) (Entry, error) {
	token, err := dec.Token()
	if err != nil {
		return Entry{}, err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return Entry{}, fmt.Errorf("must be an object")
	}
	var entry Entry
	seen := make(map[string]bool, 4)
	for dec.More() {
		fieldToken, err := dec.Token()
		if err != nil {
			return Entry{}, err
		}
		field, ok := fieldToken.(string)
		if !ok {
			return Entry{}, fmt.Errorf("invalid field name")
		}
		if seen[field] {
			return Entry{}, fmt.Errorf("duplicate field %q", field)
		}
		seen[field] = true
		switch field {
		case "id":
			err = dec.Decode(&entry.ID)
		case "name":
			err = dec.Decode(&entry.Name)
		case "path":
			err = dec.Decode(&entry.Path)
		case "writable":
			err = dec.Decode(&entry.Writable)
		default:
			return Entry{}, fmt.Errorf("unknown field %q", field)
		}
		if err != nil {
			return Entry{}, fmt.Errorf("field %q has invalid type", field)
		}
	}
	if _, err := dec.Token(); err != nil {
		return Entry{}, err
	}
	return entry, nil
}

func validateEntry(entry Entry) error {
	if !idPattern.MatchString(entry.ID) {
		return fmt.Errorf("id must match %s", idPattern.String())
	}
	if entry.Name != strings.TrimSpace(entry.Name) || entry.Name == "" || len(entry.Name) > maxNameLength || hasUnsafeUnicode(entry.Name) {
		return fmt.Errorf("name must be trimmed, nonempty, bounded, and contain no control or format characters")
	}
	if len(entry.ID) > maxIDLength || len(entry.Path) > maxPathLength || entry.Path == "" || hasUnsafeUnicode(entry.Path) || strings.Contains(entry.Path, `\`) {
		return fmt.Errorf("invalid path")
	}
	if !strings.HasPrefix(entry.Path, "/") || path.Clean(entry.Path) != entry.Path {
		return fmt.Errorf("path must be an absolute canonical Unix path")
	}
	for _, root := range []string{"/", "/data", "/proc", "/sys", "/dev"} {
		if entry.Path == root || (root != "/" && strings.HasPrefix(entry.Path, root+"/")) {
			return fmt.Errorf("path uses restricted root %q", root)
		}
	}
	base := path.Base(entry.Path)
	if base == "docker.sock" || base == "podman.sock" || base == "containerd.sock" {
		return fmt.Errorf("container runtime sockets are restricted")
	}
	return nil
}

func hasUnsafeUnicode(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return true
		}
	}
	return false
}

func validateCatalog(entries []Entry) error {
	ids, paths := make(map[string]struct{}, len(entries)), make(map[string]struct{}, len(entries))
	for index, entry := range entries {
		if err := validateEntry(entry); err != nil {
			return fmt.Errorf("catalog entry %d is invalid: %w", index, err)
		}
		if _, exists := ids[entry.ID]; exists {
			return fmt.Errorf("catalog entry %d duplicates an earlier id", index)
		}
		if _, exists := paths[entry.Path]; exists {
			return fmt.Errorf("catalog entry %d duplicates an earlier path", index)
		}
		ids[entry.ID], paths[entry.Path] = struct{}{}, struct{}{}
	}
	return nil
}

func ValidateSelection(entries []Entry, id string, writable bool) (Entry, error) {
	if err := validateCatalog(entries); err != nil {
		return Entry{}, fmt.Errorf("invalid shared directory catalog: %w", err)
	}
	for _, entry := range entries {
		if entry.ID == id {
			if writable && !entry.Writable {
				return Entry{}, fmt.Errorf("shared directory %q is read-only", id)
			}
			return entry, nil
		}
	}
	return Entry{}, fmt.Errorf("unknown shared directory %q", id)
}
