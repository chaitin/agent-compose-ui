package terminal

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"agent-compose-ui/internal/audit"

	"golang.org/x/net/http2"
	"golang.org/x/net/websocket"
)

const (
	AttachPath       = "/api/terminal/attach"
	execAttachPath   = "/agentcompose.v2.ExecService/ExecAttach"
	connectMediaType = "application/connect+proto"
	maxFrameSize     = 16 << 20
)

// Bridge adapts browser WebSocket messages to Connect's bidirectional stream
// framing. Each binary WebSocket message contains one protobuf request or
// response, so protobuf ownership stays with the generated frontend client.
type Bridge struct {
	backend  *url.URL
	client   *http.Client
	recorder *audit.Middleware
}

func NewBridge(backend *url.URL, recorder ...*audit.Middleware) *Bridge {
	bridge := newBridge(backend, &http.Client{Transport: backendTransport(backend)})
	if len(recorder) > 0 {
		bridge.recorder = recorder[0]
	}
	return bridge
}

func newBridge(backend *url.URL, client *http.Client) *Bridge {
	return &Bridge{backend: backend, client: client}
}

func (b *Bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	resourceID := safeSandboxID(r.URL.Query().Get("sandboxId"))
	websocket.Handler(func(conn *websocket.Conn) {
		err := b.serve(conn, r.Context())
		outcome, status := "success", http.StatusOK
		if err != nil {
			outcome, status = "failure", http.StatusBadGateway
		}
		b.recorder.Record(r.Context(), audit.Input{
			Actor: audit.PrincipalFromContext(r.Context()), Category: "terminal", Action: "terminal.attach",
			ResourceType: "sandbox", ResourceID: resourceID, Method: r.Method, Path: AttachPath,
			RequestID: r.Header.Get("X-Request-ID"), RemoteIP: r.RemoteAddr, UserAgent: r.UserAgent(),
			Outcome: outcome, Status: status, Duration: time.Since(started),
		})
	}).ServeHTTP(w, r)
}

func safeSandboxID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 256 {
		return ""
	}
	for _, current := range value {
		if (current >= 'a' && current <= 'z') || (current >= 'A' && current <= 'Z') ||
			(current >= '0' && current <= '9') || strings.ContainsRune("-_.:", current) {
			continue
		}
		return ""
	}
	return value
}

func (b *Bridge) serve(conn *websocket.Conn, parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	reader, writer := io.Pipe()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, b.attachURL(), reader)
	if err != nil {
		sendError(conn, err)
		return err
	}
	request.Header.Set("Content-Type", connectMediaType)
	request.Header.Set("Connect-Protocol-Version", "1")
	request.Header.Set("Accept-Encoding", "identity")

	readDone := make(chan error, 1)
	go func() {
		readDone <- copyWebSocketRequests(conn, writer)
		cancel()
	}()

	response, err := b.client.Do(request)
	if err != nil {
		_ = writer.CloseWithError(err)
		sendError(conn, err)
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(response.Body, maxFrameSize))
		err := fmt.Errorf("daemon returned %s: %s", response.Status, strings.TrimSpace(string(body)))
		sendError(conn, err)
		return err
	}

	if err := copyConnectResponses(response.Body, conn); err != nil && !errors.Is(err, io.EOF) {
		sendError(conn, err)
		return err
	}
	cancel()
	_ = writer.Close()
	select {
	case <-readDone:
	default:
	}
	return nil
}

func (b *Bridge) attachURL() string {
	target := *b.backend
	target.Path = strings.TrimRight(target.Path, "/") + execAttachPath
	target.RawQuery = ""
	target.Fragment = ""
	return target.String()
}

func backendTransport(backend *url.URL) http.RoundTripper {
	if strings.EqualFold(backend.Scheme, "http") {
		return &http2.Transport{
			AllowHTTP: true,
			DialTLSContext: func(ctx context.Context, network, address string, _ *tls.Config) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, address)
			},
		}
	}
	return http.DefaultTransport.(*http.Transport).Clone()
}

func copyWebSocketRequests(conn *websocket.Conn, writer *io.PipeWriter) error {
	defer writer.Close()
	for {
		var payload []byte
		if err := websocket.Message.Receive(conn, &payload); err != nil {
			return err
		}
		if len(payload) > maxFrameSize {
			return fmt.Errorf("terminal request frame exceeds %d bytes", maxFrameSize)
		}
		if err := writeConnectFrame(writer, 0, payload); err != nil {
			return err
		}
	}
}

func copyConnectResponses(reader io.Reader, conn *websocket.Conn) error {
	for {
		flags, payload, err := readConnectFrame(reader)
		if err != nil {
			return err
		}
		switch {
		case flags == 0:
			if err := websocket.Message.Send(conn, payload); err != nil {
				return err
			}
		case flags&2 != 0:
			if len(payload) > 0 && string(payload) != "{}" {
				return fmt.Errorf("terminal stream ended: %s", payload)
			}
			return nil
		default:
			return fmt.Errorf("unsupported Connect frame flags: %d", flags)
		}
	}
}

func writeConnectFrame(writer io.Writer, flags byte, payload []byte) error {
	header := [5]byte{flags}
	binary.BigEndian.PutUint32(header[1:], uint32(len(payload)))
	if _, err := writer.Write(header[:]); err != nil {
		return err
	}
	_, err := writer.Write(payload)
	return err
}

func readConnectFrame(reader io.Reader) (byte, []byte, error) {
	header := [5]byte{}
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return 0, nil, err
	}
	size := binary.BigEndian.Uint32(header[1:])
	if size > maxFrameSize {
		return 0, nil, fmt.Errorf("terminal response frame exceeds %d bytes", maxFrameSize)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return 0, nil, err
	}
	return header[0], payload, nil
}

func sendError(conn *websocket.Conn, err error) {
	_ = websocket.Message.Send(conn, err.Error())
}
