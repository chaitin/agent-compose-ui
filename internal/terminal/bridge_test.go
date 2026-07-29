package terminal

import (
	"bytes"
	"net/url"
	"strings"
	"testing"
)

func TestConnectFrameRoundTrip(t *testing.T) {
	payload := []byte{0x0a, 0x03, 'p', 'w', 'd'}
	var buffer bytes.Buffer
	if err := writeConnectFrame(&buffer, 0, payload); err != nil {
		t.Fatal(err)
	}
	flags, got, err := readConnectFrame(&buffer)
	if err != nil {
		t.Fatal(err)
	}
	if flags != 0 || !bytes.Equal(got, payload) {
		t.Fatalf("frame = (%d, %x), want (0, %x)", flags, got, payload)
	}
}

func TestAttachURLPreservesBackendBasePath(t *testing.T) {
	backend, err := url.Parse("https://daemon.example/base/")
	if err != nil {
		t.Fatal(err)
	}
	got := NewBridge(backend).attachURL()
	want := "https://daemon.example/base" + execAttachPath
	if got != want {
		t.Fatalf("attach URL = %q, want %q", got, want)
	}
}

func TestSafeSandboxIDAvoidsPersistingArbitraryQueryData(t *testing.T) {
	if got := safeSandboxID(" sandbox-123 "); got != "sandbox-123" {
		t.Fatalf("safe sandbox ID = %q", got)
	}
	for _, value := range []string{"", "TOKEN=secret", "sandbox/id", strings.Repeat("a", 257)} {
		if got := safeSandboxID(value); got != "" {
			t.Fatalf("unsafe sandbox ID %q accepted as %q", value, got)
		}
	}
}
