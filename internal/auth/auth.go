package auth

import (
	"crypto/rand"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"golang.org/x/oauth2"
)

const (
	authCookieName       = "agent_compose_auth"
	oauthStateCookieName = "agent_compose_oauth_state"
)

type Manager struct {
	enabled       bool
	username      string
	password      string
	secret        []byte
	ttl           time.Duration
	oauthEnabled  bool
	oauthUser     string
	oauthUserInfo string
	oauth2Config  *oauth2.Config
	oauthStateTTL time.Duration
}

func NewManagerFromEnv() *Manager {
	ttl := 24 * time.Hour
	if raw := strings.TrimSpace(os.Getenv("AUTH_SESSION_TTL")); raw != "" {
		if parsed, err := time.ParseDuration(raw); err != nil {
			slog.Warn("failed to parse AUTH_SESSION_TTL", "value", raw, "error", err)
		} else if parsed <= 0 {
			slog.Warn("AUTH_SESSION_TTL must be positive", "value", raw)
		} else {
			ttl = parsed
		}
	}
	username := strings.TrimSpace(os.Getenv("AUTH_USERNAME"))
	if username == "" {
		username = "admin"
	}
	manager := &Manager{
		enabled:       os.Getenv("AUTH_PASSWORD") != "",
		username:      username,
		password:      os.Getenv("AUTH_PASSWORD"),
		ttl:           ttl,
		oauthStateTTL: 5 * time.Minute,
	}
	manager.configureOAuth(username)
	if !manager.enabled {
		return manager
	}
	if secret := os.Getenv("AUTH_SECRET"); secret != "" {
		manager.secret = []byte(secret)
		return manager
	}
	manager.secret = make([]byte, 32)
	if _, err := rand.Read(manager.secret); err != nil {
		manager.secret = []byte(fmt.Sprintf("%d:%s", time.Now().UnixNano(), manager.password))
	}
	slog.Warn("AUTH_SECRET is not set; auth sessions will be invalid after agent-compose-ui server restart")
	return manager
}

func (a *Manager) configureOAuth(username string) {
	oauthScopes := splitAndTrimEnv(os.Getenv("OAUTH_SCOPES"))
	if len(oauthScopes) == 0 {
		oauthScopes = []string{"profile"}
	}
	oauthBaseURL := strings.TrimRight(os.Getenv("OAUTH_BASE_URL"), "/")
	oauthAuthURL := firstNonEmpty(os.Getenv("OAUTH_AUTH_URL"), oauthBaseURL+"/oauth2/auth")
	oauthTokenURL := firstNonEmpty(os.Getenv("OAUTH_TOKEN_URL"), oauthBaseURL+"/oauth2/token")
	oauthUserInfoURL := firstNonEmpty(os.Getenv("OAUTH_USERINFO_URL"), oauthBaseURL+"/userinfo")
	oauthCallbackURL := os.Getenv("OAUTH_CALLBACK_URL")
	oauthAPIKey := os.Getenv("OAUTH_APIKEY")
	a.oauthEnabled = oauthAPIKey != "" && oauthCallbackURL != "" && oauthAuthURL != "" && oauthTokenURL != ""
	if !a.oauthEnabled {
		return
	}
	a.enabled = true
	a.oauthUser = username
	if a.oauthUser == "" {
		a.oauthUser = "oauth"
	}
	a.oauthUserInfo = oauthUserInfoURL
	authStyle := oauth2.AuthStyleInParams
	clientSecret := os.Getenv("OAUTH_SECRET")
	switch strings.ToLower(strings.TrimSpace(os.Getenv("OAUTH_CLIENT_AUTH_METHOD"))) {
	case "client_secret_basic":
		authStyle = oauth2.AuthStyleInHeader
	case "none":
		clientSecret = ""
	case "client_secret_post", "":
		authStyle = oauth2.AuthStyleInParams
	default:
		slog.Warn("unsupported OAUTH_CLIENT_AUTH_METHOD; using client_secret_post", "value", os.Getenv("OAUTH_CLIENT_AUTH_METHOD"))
	}
	a.oauth2Config = &oauth2.Config{
		ClientID:     oauthAPIKey,
		ClientSecret: clientSecret,
		RedirectURL:  oauthCallbackURL,
		Scopes:       oauthScopes,
		Endpoint: oauth2.Endpoint{
			AuthURL:   oauthAuthURL,
			TokenURL:  oauthTokenURL,
			AuthStyle: authStyle,
		},
	}
}

func (a *Manager) Protect(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		r := c.Request()
		if !a.enabled || isPublicAuthPath(r.URL.Path) || isRuntimeLLMFacadeRequest(r) {
			return next(c)
		}
		if !a.protectsPath(r.URL.Path, r.Header.Get("Accept")) {
			return next(c)
		}
		if _, _, ok := a.validateRequest(r); ok {
			return next(c)
		}
		if acceptsHTML(r) {
			return c.Redirect(http.StatusFound, loginRedirectPath(r))
		}
		return echoJSON(c, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
	}
}

func (a *Manager) Enabled() bool {
	return a.enabled
}

func (a *Manager) OAuthEnabled() bool {
	return a.oauthEnabled
}

func (a *Manager) protectsPath(path string, accept string) bool {
	if strings.HasPrefix(path, "/agentcompose.v1.") || strings.HasPrefix(path, "/agentcompose.v2.") || strings.HasPrefix(path, "/health.v1.") || strings.HasPrefix(path, "/agent-compose/session/") {
		return true
	}
	if strings.HasPrefix(path, "/api/") {
		return true
	}
	return strings.Contains(accept, "text/html")
}
