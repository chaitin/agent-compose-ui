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
	"agent-compose-ui/internal/proxy"
)

const (
	listenAddress   = "127.0.0.1:8080"
	shutdownTimeout = 10 * time.Second
)

func New(cfg config.Config) http.Handler {
	manager := auth.New(cfg)
	daemonProxy := manager.Require(proxy.NewDaemon(cfg.AgentComposeURL))
	scriptProxy := manager.Require(proxy.NewScripts(cfg.ScriptServiceURL, cfg.ScriptServiceToken))
	authHandler := recoverAuthPanics(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveAuth(manager, w, r)
	}))
	return routeHandler(authHandler, scriptProxy, daemonProxy)
}

func routeHandler(authHandler, scriptProxy, daemonProxy http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case path == "/api/auth" || strings.HasPrefix(path, "/api/auth/"):
			authHandler.ServeHTTP(w, r)
		case strings.HasPrefix(path, "/script-api/"):
			scriptProxy.ServeHTTP(w, r)
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
	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr:              listenAddress,
		Handler:           New(cfg),
		ReadHeaderTimeout: 10 * time.Second,
	}
	return serve(ctx, server, listener)
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
		strings.HasPrefix(path, "/agent-compose/session/")
}

func methodNotAllowed(w http.ResponseWriter, methods ...string) {
	w.Header().Set("Allow", strings.Join(methods, ", "))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusMethodNotAllowed)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "method not allowed"})
}

func recoverAuthPanics(next http.Handler) http.Handler {
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
