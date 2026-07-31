package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"agent-compose-ui/internal/apitoken"
	"agent-compose-ui/internal/auth"
	"agent-compose-ui/internal/config"
	"agent-compose-ui/internal/localfs"
	"agent-compose-ui/internal/projectenv"
	"agent-compose-ui/internal/proxy"
	"agent-compose-ui/internal/tokenproxy"
)

const (
	shutdownTimeout = 10 * time.Second
	tokenListenAddr = ":8081"
)

func New(cfg config.Config) http.Handler {
	handlers, cleanup, err := newHandlers(cfg, nil)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "gateway unavailable", http.StatusServiceUnavailable)
		})
	}
	_ = cleanup
	return handlers.browser
}

type gatewayHandlers struct {
	browser http.Handler
	token   http.Handler
}

func newHandlers(cfg config.Config, logger *slog.Logger) (gatewayHandlers, func() error, error) {
	manager := auth.New(cfg)
	var daemonHandler http.Handler = proxy.NewDaemon(cfg.AgentComposeURL)
	cleanup := func() error { return nil }
	if cfg.AgentComposeDBPath != "" {
		globals, err := projectenv.OpenGlobalStore(cfg.AgentComposeDBPath)
		if err != nil {
			return gatewayHandlers{}, cleanup, err
		}
		shadows, err := projectenv.OpenShadowStore(cfg.UIStateDBPath)
		if err != nil {
			_ = globals.Close()
			return gatewayHandlers{}, cleanup, err
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
	managementHandler := apitoken.UnavailableHandler()
	machineHandler := tokenproxy.UnavailableHandler()
	if cfg.TokenDBPath != "" {
		store, err := apitoken.OpenStore(cfg.TokenDBPath)
		if err != nil {
			_ = cleanup()
			return gatewayHandlers{}, func() error { return nil }, err
		}
		previousCleanup := cleanup
		cleanup = func() error { return errors.Join(store.Close(), previousCleanup()) }
		managementHandler = apitoken.NewHTTPHandler(store)
		machineHandler = tokenproxy.New(store, proxy.NewTokenDaemon(cfg.AgentComposeURL), logger)
	}
	return gatewayHandlers{
		browser: recoverHTTPPanics(routeHandler(authHandler, managementHandler, scriptProxy, daemonProxy, projectStorage)),
		token:   recoverHTTPPanics(machineHandler),
	}, cleanup, nil
}

func routeHandler(authHandler, managementHandler, scriptProxy, daemonProxy http.Handler, storageHandlers ...http.Handler) http.Handler {
	var projectStorage http.Handler = localfs.New()
	if len(storageHandlers) > 0 && storageHandlers[0] != nil {
		projectStorage = storageHandlers[0]
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case path == "/api/auth" || strings.HasPrefix(path, "/api/auth/"):
			authHandler.ServeHTTP(w, r)
		case path == "/ui-api" || strings.HasPrefix(path, "/ui-api/"):
			managementHandler.ServeHTTP(w, r)
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

func Run(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	if ctx.Err() != nil {
		return nil
	}
	browserListener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return err
	}
	tokenListener, err := net.Listen("tcp", tokenListenAddr)
	if err != nil {
		_ = browserListener.Close()
		return err
	}
	handlers, cleanup, err := newHandlers(cfg, logger)
	if err != nil {
		_ = browserListener.Close()
		_ = tokenListener.Close()
		return err
	}
	defer func() { _ = cleanup() }()
	browserServer := newServer(cfg, handlers.browser)
	tokenServer := newTokenServer(handlers.token)
	return servePair(ctx, browserServer, browserListener, tokenServer, tokenListener)
}

func newServer(cfg config.Config, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
}

func newTokenServer(handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              tokenListenAddr,
		Handler:           h2c.NewHandler(handler, &http2.Server{}), //nolint:staticcheck // Attach RPCs require cleartext HTTP/2.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    32 << 10,
	}
}

type servingServer struct {
	server   *http.Server
	listener net.Listener
}

func servePair(ctx context.Context, browser *http.Server, browserListener net.Listener, token *http.Server, tokenListener net.Listener) error {
	servers := []servingServer{{browser, browserListener}, {token, tokenListener}}
	results := make(chan error, len(servers))
	for _, item := range servers {
		go func() { results <- normalizeServeError(item.server.Serve(item.listener)) }()
	}

	var firstErr error
	received := 0
	select {
	case firstErr = <-results:
		received = 1
	case <-ctx.Done():
	}
	shutdownErr := shutdownAll(servers, shutdownTimeout)
	for received < len(servers) {
		firstErr = errors.Join(firstErr, <-results)
		received++
	}
	return errors.Join(firstErr, shutdownErr)
}

func shutdownAll(servers []servingServer, timeout time.Duration) error {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var wg sync.WaitGroup
	errorsByServer := make([]error, len(servers))
	for index, item := range servers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := item.server.Shutdown(shutdownCtx); err != nil {
				errorsByServer[index] = errors.Join(err, item.server.Close())
			}
		}()
	}
	wg.Wait()
	return errors.Join(errorsByServer...)
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
