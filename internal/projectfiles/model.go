package projectfiles

import "time"

// Entry describes one immediate child returned by List.
type Entry struct {
	Path    string    `json:"path"`
	Name    string    `json:"name"`
	IsDir   bool      `json:"isDir"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
	SHA256  string    `json:"sha256,omitempty"`
}

// File is a regular resource file and its content metadata.
type File struct {
	Path    string    `json:"path"`
	Name    string    `json:"name"`
	IsDir   bool      `json:"isDir"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
	SHA256  string    `json:"sha256"`
	// Content is internal binary-safe data. HTTP handlers must deliberately
	// project text content or stream downloads; implicit JSON base64 is not the
	// transport contract.
	Content []byte `json:"-"`
}
