package app

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"time"

	"agent-compose-ui/internal/auth"
	"agent-compose-ui/internal/config"
	"agent-compose-ui/internal/proxy"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/samber/do/v2"
)

func Run() error {
	di := do.New()
	Register(di)

	server := do.MustInvoke[*http.Server](di)
	logger := do.MustInvoke[*slog.Logger](di)
	authManager := do.MustInvoke[*auth.Manager](di)
	backend := do.MustInvoke[*url.URL](di)
	cfg := do.MustInvoke[config.Config](di)
	logger.Info("agent-compose-ui server started", "listen", cfg.ListenAddr, "backend", backend.String(), "auth_enabled", authManager.Enabled(), "oauth_enabled", authManager.OAuthEnabled())
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
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
	do.Provide(di, NewHTTPServer)
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
	registerRoutes(app, do.MustInvoke[*auth.Manager](di), do.MustInvoke[http.Handler](di))
	return app, nil
}

func NewAuthManager(di do.Injector) (*auth.Manager, error) {
	return auth.NewManagerFromEnv(), nil
}

func NewBackendProxy(di do.Injector) (http.Handler, error) {
	cfg := do.MustInvoke[config.Config](di)
	return proxy.NewBackendProxy(do.MustInvoke[*url.URL](di), proxy.BackendProxyOptions{
		AuthorizationHeader: cfg.BackendAuthorizationHeader,
	}), nil
}

func NewHTTPServer(di do.Injector) (*http.Server, error) {
	cfg := do.MustInvoke[config.Config](di)
	return &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           do.MustInvoke[*echo.Echo](di),
		ReadHeaderTimeout: 15 * time.Second,
	}, nil
}

func registerRoutes(app *echo.Echo, authManager *auth.Manager, backend http.Handler) {
	app.GET("/api/auth/status", authManager.HandleStatus)
	app.HEAD("/api/auth/status", authManager.HandleStatus)
	app.POST("/api/auth/login", authManager.HandleLogin)
	app.POST("/api/auth/logout", authManager.HandleLogout)
	app.GET("/oauth/authorize", authManager.HandleOAuthAuthorize)
	app.HEAD("/oauth/authorize", authManager.HandleOAuthAuthorize)
	app.GET("/oauth/callback", authManager.HandleOAuthCallback)
	app.HEAD("/oauth/callback", authManager.HandleOAuthCallback)
	app.Any("/*", authManager.Protect(echo.WrapHandler(backend)))
}
