package app

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"agent-compose-ui/internal/auth"
	"agent-compose-ui/internal/config"
	"agent-compose-ui/internal/localfs"
	"agent-compose-ui/internal/projectenv"
	"agent-compose-ui/internal/proxy"
)

const (
	shutdownTimeout = 10 * time.Second
)

func New(cfg config.Config) http.Handler {
	handler, cleanup, err := newHandler(cfg)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "gateway unavailable", http.StatusServiceUnavailable)
		})
	}
	_ = cleanup
	return handler
}

func newHandler(cfg config.Config) (http.Handler, func() error, error) {
	manager := auth.New(cfg)
	var daemonHandler http.Handler = proxy.NewDaemon(cfg.AgentComposeURL)
	cleanup := func() error { return nil }
	if cfg.AgentComposeDBPath != "" {
		globals, err := projectenv.OpenGlobalStore(cfg.AgentComposeDBPath)
		if err != nil {
			return nil, cleanup, err
		}
		shadows, err := projectenv.OpenShadowStore(cfg.UIStateDBPath)
		if err != nil {
			_ = globals.Close()
			return nil, cleanup, err
		}
		fallback := daemonHandler
		daemonHandler = projectenv.NewHandler(cfg.AgentComposeURL, globals, shadows, fallback)
		cleanup = func() error { return errors.Join(shadows.Close(), globals.Close()) }
	}
	daemonProxy := manager.Require(daemonHandler)
	scriptProxy := manager.Require(proxy.NewScripts(cfg.ScriptServiceURL, cfg.ScriptServiceToken))
	projectStorage := manager.Require(localfs.New(localfs.NewStorage(cfg.ProjectStorageRoot, cfg.LegacyProjectStorageRoot)))
	authHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveAuth(manager, w, r)
	})
	return recoverHTTPPanics(routeHandler(authHandler, scriptProxy, daemonProxy, projectStorage)), cleanup, nil
}

func routeHandler(authHandler, scriptProxy, daemonProxy http.Handler, storageHandlers ...http.Handler) http.Handler {
	var projectStorage http.Handler = localfs.New()
	if len(storageHandlers) > 0 && storageHandlers[0] != nil {
		projectStorage = storageHandlers[0]
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case path == "/api/auth" || strings.HasPrefix(path, "/api/auth/"):
			authHandler.ServeHTTP(w, r)
		case strings.HasPrefix(path, "/script-api/"):
			scriptProxy.ServeHTTP(w, r)
		case strings.HasPrefix(path, "/api/local-workspace/") || strings.HasPrefix(path, "/api/project-storage/"):
			projectStorage.ServeHTTP(w, r)
		case isDaemonPath(path):
			daemonProxy.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

func Run(ctx context.Context, cfg config.Config) error {
	if ctx.Err() != nil {
		return nil
	}
	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return err
	}
	handler, cleanup, err := newHandler(cfg)
	if err != nil {
		_ = listener.Close()
		return err
	}
	defer func() { _ = cleanup() }()
	server := newServer(cfg, handler)
	return serve(ctx, server, listener)
}

func newServer(cfg config.Config, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
}

func serve(ctx context.Context, server *http.Server, listener net.Listener) error {
	return serveWithShutdownTimeout(ctx, server, listener, shutdownTimeout)
}

func serveWithShutdownTimeout(ctx context.Context, server *http.Server, listener net.Listener, timeout time.Duration) error {
	serveResult := make(chan error, 1)
	go func() {
		serveResult <- server.Serve(listener)
	}()

	select {
	case err := <-serveResult:
		return normalizeServeError(err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
		shutdownErr := server.Shutdown(shutdownCtx)
		cancel()
		if shutdownErr != nil {
			closeErr := server.Close()
			serveErr := normalizeServeError(<-serveResult)
			return errors.Join(shutdownErr, closeErr, serveErr)
		}
		return normalizeServeError(<-serveResult)
	}
}

func normalizeServeError(err error) error {
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func serveAuth(manager *auth.Manager, w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/auth/status":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			methodNotAllowed(w, http.MethodGet, http.MethodHead)
			return
		}
		manager.Status(w, r)
	case "/api/auth/login":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		manager.Login(w, r)
	case "/api/auth/logout":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		manager.Logout(w, r)
	default:
		http.NotFound(w, r)
	}
}

func isDaemonPath(path string) bool {
	return strings.HasPrefix(path, "/agentcompose.v1.") ||
		strings.HasPrefix(path, "/agentcompose.v2.") ||
		strings.HasPrefix(path, "/health.v1.") ||
		strings.HasPrefix(path, "/api/") ||
		strings.HasPrefix(path, "/oauth/") ||
		strings.HasPrefix(path, "/agent-compose/session/") ||
		path == "/jupyter" ||
		strings.HasPrefix(path, "/jupyter/")
}

func methodNotAllowed(w http.ResponseWriter, methods ...string) {
	w.Header().Set("Allow", strings.Join(methods, ", "))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusMethodNotAllowed)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "method not allowed"})
}

func recoverHTTPPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				if recovered == http.ErrAbortHandler {
					panic(recovered)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "internal server error"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}
