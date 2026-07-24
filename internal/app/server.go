package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"agent-compose-ui/internal/apitoken"
	"agent-compose-ui/internal/auth"
	"agent-compose-ui/internal/config"
	"agent-compose-ui/internal/proxy"
	"agent-compose-ui/internal/tokenproxy"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/samber/do/v2"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

const (
	shutdownTimeout = 10 * time.Second
	tokenListenAddr = ":8081"
)

func Run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	di := do.New()
	Register(di)

	browserServer := do.MustInvoke[*http.Server](di)
	tokenServer := do.MustInvokeNamed[*http.Server](di, "token")
	tokens := do.MustInvoke[*TokenRuntime](di)
	defer func() {
		if err := tokens.Close(); err != nil {
			slog.Error("close token store", "error", err)
		}
	}()
	logger := do.MustInvoke[*slog.Logger](di)
	authManager := do.MustInvoke[*auth.Manager](di)
	backend := do.MustInvoke[*url.URL](di)
	cfg := do.MustInvoke[config.Config](di)
	logger.Info("agent-compose-ui server started", "listen", cfg.ListenAddr, "token_listen", tokenListenAddr, "token_enabled", cfg.TokenDBPath != "", "backend", backend.String(), "auth_enabled", authManager.Enabled(), "oauth_enabled", authManager.OAuthEnabled())
	if err := servePair(ctx, browserServer, tokenServer); err != nil {
		return fmt.Errorf("agent-compose-ui server failed: %w", err)
	}
	return nil
}

func Register(di do.Injector) {
	do.Provide(di, NewLogger)
	do.Provide(di, NewConfig)
	do.Provide(di, NewBackendURL)
	do.Provide(di, NewEcho)
	do.Provide(di, NewAuthManager)
	do.Provide(di, NewBackendProxy)
	do.Provide(di, NewTokenRuntime)
	do.Provide(di, NewHTTPServer)
	do.ProvideNamed(di, "token", NewTokenHTTPServer)
}

func NewLogger(di do.Injector) (*slog.Logger, error) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	slog.SetDefault(logger)
	return logger, nil
}

func NewConfig(di do.Injector) (config.Config, error) {
	return config.LoadFromEnv(), nil
}

func NewBackendURL(di do.Injector) (*url.URL, error) {
	cfg := do.MustInvoke[config.Config](di)
	backend, err := url.Parse(cfg.BackendURL)
	if err != nil {
		return nil, fmt.Errorf("parse backend URL: %w", err)
	}
	return backend, nil
}

func NewEcho(di do.Injector) (*echo.Echo, error) {
	app := echo.New()
	app.HideBanner = true
	app.HidePort = true
	app.Use(middleware.RequestLogger())
	app.Use(middleware.Recover())
	registerRoutes(app, do.MustInvoke[*auth.Manager](di), do.MustInvoke[http.Handler](di), do.MustInvoke[*TokenRuntime](di).Management)
	return app, nil
}

func NewAuthManager(di do.Injector) (*auth.Manager, error) {
	return auth.NewManagerFromEnv(), nil
}

func NewBackendProxy(di do.Injector) (http.Handler, error) {
	return proxy.NewBackendProxy(do.MustInvoke[*url.URL](di)), nil
}

type TokenRuntime struct {
	Management http.Handler
	Machine    http.Handler
	store      *apitoken.Store
}

func NewTokenRuntime(di do.Injector) (*TokenRuntime, error) {
	cfg := do.MustInvoke[config.Config](di)
	if cfg.TokenDBPath == "" {
		return &TokenRuntime{
			Management: apitoken.UnavailableHandler(),
			Machine:    tokenproxy.UnavailableHandler(),
		}, nil
	}
	store, err := apitoken.OpenStore(cfg.TokenDBPath)
	if err != nil {
		return nil, err
	}
	return &TokenRuntime{
		Management: apitoken.NewHTTPHandler(store),
		Machine: tokenproxy.New(
			store,
			proxy.NewTokenBackendProxy(do.MustInvoke[*url.URL](di)),
			do.MustInvoke[*slog.Logger](di),
		),
		store: store,
	}, nil
}

func (r *TokenRuntime) Close() error {
	if r == nil {
		return nil
	}
	return r.store.Close()
}

func NewHTTPServer(di do.Injector) (*http.Server, error) {
	cfg := do.MustInvoke[config.Config](di)
	return &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           do.MustInvoke[*echo.Echo](di),
		ReadHeaderTimeout: 15 * time.Second,
	}, nil
}

func NewTokenHTTPServer(di do.Injector) (*http.Server, error) {
	return &http.Server{
		Addr:              tokenListenAddr,
		Handler:           h2c.NewHandler(do.MustInvoke[*TokenRuntime](di).Machine, &http2.Server{}), //nolint:staticcheck // Attach RPCs require cleartext HTTP/2.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    32 << 10,
	}, nil
}

func registerRoutes(app *echo.Echo, authManager *auth.Manager, backend, tokenManagement http.Handler) {
	app.GET("/api/auth/status", authManager.HandleStatus)
	app.HEAD("/api/auth/status", authManager.HandleStatus)
	app.POST("/api/auth/login", authManager.HandleLogin)
	app.POST("/api/auth/logout", authManager.HandleLogout)
	app.GET("/oauth/authorize", authManager.HandleOAuthAuthorize)
	app.HEAD("/oauth/authorize", authManager.HandleOAuthAuthorize)
	app.GET("/oauth/callback", authManager.HandleOAuthCallback)
	app.HEAD("/oauth/callback", authManager.HandleOAuthCallback)
	app.Any("/ui-api/*", authManager.Protect(echo.WrapHandler(tokenManagement)))
	app.Any("/*", authManager.Protect(echo.WrapHandler(backend)))
}

func servePair(ctx context.Context, browser, token *http.Server) error {
	servers := []*http.Server{browser, token}
	results := make(chan error, len(servers))
	for _, server := range servers {
		go func() { results <- normalizeServeError(server.ListenAndServe()) }()
	}

	var firstErr error
	received := 0
	select {
	case firstErr = <-results:
		received = 1
	case <-ctx.Done():
	}
	shutdownErr := shutdownAll(servers)
	for received < len(servers) {
		firstErr = errors.Join(firstErr, <-results)
		received++
	}
	return errors.Join(firstErr, shutdownErr)
}

func shutdownAll(servers []*http.Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	errorsByServer := make([]error, len(servers))
	var wg sync.WaitGroup
	for index, server := range servers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := server.Shutdown(ctx); err != nil {
				errorsByServer[index] = errors.Join(err, server.Close())
			}
		}()
	}
	wg.Wait()
	return errors.Join(errorsByServer...)
}

func normalizeServeError(err error) error {
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
