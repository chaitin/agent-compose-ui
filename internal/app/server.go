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

	"agent-compose-ui/internal/agentrecords"
	"agent-compose-ui/internal/apitoken"
	"agent-compose-ui/internal/audit"
	"agent-compose-ui/internal/auth"
	"agent-compose-ui/internal/config"
	"agent-compose-ui/internal/projectdeploy"
	"agent-compose-ui/internal/proxy"
	"agent-compose-ui/internal/runindex"
	"agent-compose-ui/internal/terminal"
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
	audits := do.MustInvoke[*AuditRuntime](di)
	if audits.Store != nil {
		go func() {
			ticker := time.NewTicker(24 * time.Hour)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if err := audits.Store.Cleanup(context.Background()); err != nil {
						slog.Error("clean audit store", "error", err)
					}
				}
			}
		}()
	}
	defer func() {
		if err := tokens.Close(); err != nil {
			slog.Error("close token store", "error", err)
		}
	}()
	defer func() {
		if err := audits.Close(); err != nil {
			slog.Error("close audit store", "error", err)
		}
	}()
	logger := do.MustInvoke[*slog.Logger](di)
	authManager := do.MustInvoke[*auth.Manager](di)
	backend := do.MustInvoke[*url.URL](di)
	cfg := do.MustInvoke[config.Config](di)
	logger.Info("agent-compose-ui server started", "listen", cfg.ListenAddr, "token_listen", tokenListenAddr, "database_enabled", cfg.DatabasePath != "", "backend", backend.String(), "auth_enabled", authManager.Enabled(), "oauth_enabled", authManager.OAuthEnabled())
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
	do.Provide(di, NewProjectDeployHandler)
	do.Provide(di, NewRunIndexHandler)
	do.Provide(di, NewAgentRecordsHandler)
	do.Provide(di, NewAuditRuntime)
	do.Provide(di, NewTokenRuntime)
	do.Provide(di, NewTerminalBridge)
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
	app.Use(middleware.RequestID())
	app.Use(middleware.RequestLogger())
	app.Use(middleware.Recover())
	registerRoutes(
		app,
		do.MustInvoke[*auth.Manager](di),
		do.MustInvoke[*terminal.Bridge](di),
		do.MustInvoke[http.Handler](di),
		do.MustInvoke[*projectdeploy.Handler](di),
		do.MustInvoke[*runindex.Handler](di),
		do.MustInvoke[*agentrecords.Handler](di),
		do.MustInvoke[*TokenRuntime](di).Management,
		do.MustInvoke[*AuditRuntime](di),
	)
	return app, nil
}

func NewAuthManager(di do.Injector) (*auth.Manager, error) {
	return auth.NewManagerFromEnv(do.MustInvoke[*AuditRuntime](di).Store), nil
}

func NewBackendProxy(di do.Injector) (http.Handler, error) {
	return proxy.NewBackendProxy(do.MustInvoke[*url.URL](di)), nil
}

func NewProjectDeployHandler(di do.Injector) (*projectdeploy.Handler, error) {
	return projectdeploy.New(do.MustInvoke[*url.URL](di)), nil
}

func NewRunIndexHandler(di do.Injector) (*runindex.Handler, error) {
	return runindex.New(do.MustInvoke[*url.URL](di)), nil
}

func NewAgentRecordsHandler(di do.Injector) (*agentrecords.Handler, error) {
	return agentrecords.New(do.MustInvoke[config.Config](di).SandboxRoot), nil
}

type AuditRuntime struct {
	Management http.Handler
	Middleware *audit.Middleware
	Store      *audit.Store
}

func NewAuditRuntime(di do.Injector) (*AuditRuntime, error) {
	cfg := do.MustInvoke[config.Config](di)
	logger := do.MustInvoke[*slog.Logger](di)
	if cfg.DatabasePath == "" {
		return &AuditRuntime{Management: audit.UnavailableHandler(), Middleware: audit.NewMiddleware(nil, logger)}, nil
	}
	store, err := audit.OpenStore(cfg.DatabasePath, cfg.AuditRetentionDay)
	if err != nil {
		return nil, err
	}
	return &AuditRuntime{Management: audit.NewHTTPHandler(store), Middleware: audit.NewMiddleware(store, logger), Store: store}, nil
}

func (r *AuditRuntime) Close() error {
	if r == nil || r.Store == nil {
		return nil
	}
	return r.Store.Close()
}

type TokenRuntime struct {
	Management http.Handler
	Machine    http.Handler
	store      *apitoken.Store
}

func NewTokenRuntime(di do.Injector) (*TokenRuntime, error) {
	cfg := do.MustInvoke[config.Config](di)
	if cfg.DatabasePath == "" {
		return &TokenRuntime{
			Management: apitoken.UnavailableHandler(),
			Machine:    tokenproxy.UnavailableHandler(),
		}, nil
	}
	store, err := apitoken.OpenStore(cfg.DatabasePath)
	if err != nil {
		return nil, err
	}
	return &TokenRuntime{
		Management: apitoken.NewHTTPHandler(store),
		Machine: tokenproxy.NewWithAudit(
			store,
			proxy.NewTokenBackendProxy(do.MustInvoke[*url.URL](di)),
			do.MustInvoke[*slog.Logger](di),
			do.MustInvoke[*AuditRuntime](di).Middleware,
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

func NewTerminalBridge(di do.Injector) (*terminal.Bridge, error) {
	return terminal.NewBridge(do.MustInvoke[*url.URL](di), do.MustInvoke[*AuditRuntime](di).Middleware), nil
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

func registerRoutes(
	app *echo.Echo,
	authManager *auth.Manager,
	terminalBridge *terminal.Bridge,
	backend http.Handler,
	projectDeploy http.Handler,
	runIndex http.Handler,
	agentRecords http.Handler,
	tokenManagement http.Handler,
	audits *AuditRuntime,
) {
	app.GET("/api/auth/status", authManager.HandleStatus)
	app.HEAD("/api/auth/status", authManager.HandleStatus)
	app.POST("/api/auth/login", authManager.HandleLogin)
	app.POST("/api/auth/logout", authManager.HandleLogout)
	app.GET("/oauth/authorize", authManager.HandleOAuthAuthorize)
	app.HEAD("/oauth/authorize", authManager.HandleOAuthAuthorize)
	app.GET("/oauth/callback", authManager.HandleOAuthCallback)
	app.HEAD("/oauth/callback", authManager.HandleOAuthCallback)
	app.Any("/api/ui/v1/audit/*", authManager.Protect(echo.WrapHandler(audits.Management)))
	app.Any("/api/ui/v1/projects", authManager.Protect(echo.WrapHandler(projectDeploy)))
	app.Any("/api/ui/v1/projects/*", authManager.Protect(echo.WrapHandler(projectDeploy)))
	app.Any("/api/ui/v1/project-deployment-previews", authManager.Protect(echo.WrapHandler(audits.Middleware.Wrap(projectDeploy))))
	app.Any("/api/ui/v1/project-deployment-previews/*", authManager.Protect(echo.WrapHandler(audits.Middleware.Wrap(projectDeploy))))
	app.GET("/api/ui/v1/runs/unlinked", authManager.Protect(echo.WrapHandler(runIndex)))
	app.GET("/api/ui/v1/sandboxes/:sandboxID/agent-records", authManager.Protect(echo.WrapHandler(agentRecords)))
	app.GET("/api/ui/v1/sandboxes/:sandboxID/agent-records/*", authManager.Protect(echo.WrapHandler(agentRecords)))
	app.Any("/api/ui/v1/tokens", authManager.Protect(echo.WrapHandler(audits.Middleware.Wrap(tokenManagement))))
	app.Any("/api/ui/v1/tokens/*", authManager.Protect(echo.WrapHandler(audits.Middleware.Wrap(tokenManagement))))
	app.GET(terminal.AttachPath, authManager.Protect(echo.WrapHandler(terminalBridge)))
	app.Any("/*", authManager.Protect(echo.WrapHandler(audits.Middleware.Wrap(backend))))
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
