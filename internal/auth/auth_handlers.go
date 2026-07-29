package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"agent-compose-ui/internal/audit"

	"github.com/labstack/echo/v4"
	"golang.org/x/oauth2"
)

type authStatusResponse struct {
	Enabled      bool             `json:"enabled"`
	LoggedIn     bool             `json:"loggedIn"`
	OAuthEnabled bool             `json:"oauthEnabled"`
	Username     string           `json:"username,omitempty"`
	ExpiresAt    string           `json:"expiresAt,omitempty"`
	User         *audit.Principal `json:"user,omitempty"`
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (a *Manager) HandleStatus(c echo.Context) error {
	r := c.Request()
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return c.NoContent(http.StatusMethodNotAllowed)
	}
	principal, expiresAt, ok := a.validateRequest(r)
	resp := authStatusResponse{Enabled: a.enabled, LoggedIn: !a.enabled || ok, OAuthEnabled: a.oauthEnabled}
	if ok {
		resp.Username = principal.Username
		resp.ExpiresAt = expiresAt.UTC().Format(time.RFC3339)
		resp.User = &principal
	}
	return echoJSON(c, http.StatusOK, resp)
}

func (a *Manager) HandleLogin(c echo.Context) error {
	r := c.Request()
	if r.Method != http.MethodPost {
		return c.NoContent(http.StatusMethodNotAllowed)
	}
	if !a.enabled {
		return echoJSON(c, http.StatusOK, authStatusResponse{Enabled: false, LoggedIn: true})
	}
	if a.password == "" {
		return echoJSON(c, http.StatusUnauthorized, map[string]string{"error": "password login is not configured"})
	}
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return echoJSON(c, http.StatusBadRequest, map[string]string{"error": "invalid login request"})
	}
	if !constantTimeEqual(req.Username, a.username) || !constantTimeEqual(req.Password, a.password) {
		a.record(r, audit.Input{Actor: audit.Principal{ID: "anonymous", Source: "anonymous", Username: req.Username, DisplayName: req.Username, AuthMethod: "password"}, Category: "authentication", Action: "login", Method: r.Method, Path: r.URL.Path, Outcome: "denied", Status: http.StatusUnauthorized})
		return echoJSON(c, http.StatusUnauthorized, map[string]string{"error": "invalid username or password"})
	}
	expiresAt := time.Now().UTC().Add(a.ttl)
	principal := a.localPrincipal()
	c.SetCookie(a.cookie(a.signedValue(principal, expiresAt), expiresAt))
	a.record(r, audit.Input{Actor: principal, Category: "authentication", Action: "login", Method: r.Method, Path: r.URL.Path, Outcome: "success", Status: http.StatusOK})
	return echoJSON(c, http.StatusOK, authStatusResponse{Enabled: true, LoggedIn: true, Username: a.username, ExpiresAt: expiresAt.Format(time.RFC3339), User: &principal})
}

func (a *Manager) HandleLogout(c echo.Context) error {
	r := c.Request()
	principal, _, _ := a.validateRequest(r)
	c.SetCookie(a.cookie("", time.Unix(0, 0).UTC()))
	a.record(r, audit.Input{Actor: principal, Category: "authentication", Action: "logout", Method: r.Method, Path: r.URL.Path, Outcome: "success", Status: http.StatusOK})
	return echoJSON(c, http.StatusOK, authStatusResponse{Enabled: a.enabled, LoggedIn: false})
}

func (a *Manager) HandleOAuthAuthorize(c echo.Context) error {
	r := c.Request()
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return c.NoContent(http.StatusMethodNotAllowed)
	}
	if !a.oauthEnabled || a.oauth2Config == nil {
		return echoJSON(c, http.StatusNotFound, map[string]string{"error": "oauth is not configured"})
	}
	state, err := generateOAuthState(16)
	if err != nil {
		return echoJSON(c, http.StatusInternalServerError, map[string]string{"error": "failed to start oauth login"})
	}
	next := sanitizeOAuthNext(r.URL.Query().Get("next"))
	c.SetCookie(a.oauthStateCookie(state, next, time.Now().UTC().Add(a.oauthStateTTL)))
	authURL := a.oauth2Config.AuthCodeURL(state, oauth2.SetAuthURLParam("scope", strings.Join(a.oauth2Config.Scopes, " ")))
	return c.Redirect(http.StatusFound, authURL)
}

func (a *Manager) HandleOAuthCallback(c echo.Context) error {
	r := c.Request()
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return c.NoContent(http.StatusMethodNotAllowed)
	}
	if !a.oauthEnabled || a.oauth2Config == nil {
		a.recordOAuthFailure(r, http.StatusNotFound)
		return echoJSON(c, http.StatusNotFound, map[string]string{"error": "oauth is not configured"})
	}
	if authErr := r.URL.Query().Get("error"); authErr != "" {
		a.recordOAuthFailure(r, http.StatusBadRequest)
		return echoJSON(c, http.StatusBadRequest, map[string]string{"error": "oauth authorization failed: " + authErr})
	}
	stateCookie, err := r.Cookie(oauthStateCookieName)
	if err != nil || stateCookie.Value == "" {
		a.recordOAuthFailure(r, http.StatusBadRequest)
		return echoJSON(c, http.StatusBadRequest, map[string]string{"error": "oauth state cookie missing or expired"})
	}
	c.SetCookie(a.oauthStateCookie("", "", time.Unix(0, 0).UTC()))
	expectedState, next, ok := decodeOAuthStateCookie(stateCookie.Value)
	if !ok || expectedState == "" || expectedState != r.URL.Query().Get("state") {
		a.recordOAuthFailure(r, http.StatusBadRequest)
		return echoJSON(c, http.StatusBadRequest, map[string]string{"error": "oauth state mismatch"})
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		a.recordOAuthFailure(r, http.StatusBadRequest)
		return echoJSON(c, http.StatusBadRequest, map[string]string{"error": "authorization code is missing"})
	}
	token, err := a.oauth2Config.Exchange(r.Context(), code)
	if err != nil {
		slog.Error("oauth token exchange failed", "error", err, "token_url", a.oauth2Config.Endpoint.TokenURL, "redirect_url", a.oauth2Config.RedirectURL)
		a.recordOAuthFailure(r, http.StatusBadGateway)
		return echoJSON(c, http.StatusBadGateway, map[string]string{"error": "failed to exchange authorization code"})
	}
	profile, err := a.fetchOAuthProfile(r, token)
	if err != nil {
		a.recordOAuthFailure(r, http.StatusBadGateway)
		return echoJSON(c, http.StatusBadGateway, map[string]string{"error": "failed to retrieve oauth user"})
	}
	principal := a.oauthPrincipal(profile)
	if a.auditStore != nil {
		if err := a.auditStore.UpsertOAuthPrincipal(r.Context(), a.oauthProvider, profile.Subject, principal); err != nil {
			slog.Error("oauth principal persistence failed", "error", err)
		}
	}
	expiresAt := time.Now().UTC().Add(a.ttl)
	c.SetCookie(a.cookie(a.signedValue(principal, expiresAt), expiresAt))
	a.record(r, audit.Input{Actor: principal, Category: "authentication", Action: "oauth.login", Method: r.Method, Path: r.URL.Path, Outcome: "success", Status: http.StatusFound})
	return c.Redirect(http.StatusFound, sanitizeOAuthNext(next))
}

func (a *Manager) recordOAuthFailure(r *http.Request, status int) {
	a.record(r, audit.Input{
		Actor:    audit.Principal{ID: "anonymous", Source: "oauth", Username: "anonymous", DisplayName: "匿名", AuthMethod: "oauth"},
		Category: "authentication", Action: "oauth.login", Method: r.Method, Path: r.URL.Path,
		Outcome: "failure", Status: status,
	})
}

type oauthProfile struct{ Subject, Username, DisplayName string }

func (a *Manager) fetchOAuthProfile(r *http.Request, token *oauth2.Token) (oauthProfile, error) {
	if a.oauthUserInfo == "" {
		return oauthProfile{Subject: a.oauthUser, Username: a.oauthUser, DisplayName: a.oauthUser}, nil
	}
	client := a.oauth2Config.Client(r.Context(), token)
	resp, err := client.Get(a.oauthUserInfo)
	if err != nil {
		return oauthProfile{}, fmt.Errorf("call userinfo endpoint: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= http.StatusBadRequest {
		return oauthProfile{}, fmt.Errorf("userinfo status %d", resp.StatusCode)
	}
	var info struct {
		ID       string `json:"id"`
		Sub      string `json:"sub"`
		Username string `json:"username"`
		Name     string `json:"name"`
		Email    string `json:"email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return oauthProfile{}, fmt.Errorf("decode userinfo: %w", err)
	}
	subject := firstNonEmpty(info.Sub, info.ID, info.Username, info.Email, a.oauthUser)
	username := firstNonEmpty(info.Username, info.Email, info.Name, subject)
	return oauthProfile{Subject: subject, Username: username, DisplayName: firstNonEmpty(info.Name, username)}, nil
}

func (a *Manager) oauthPrincipal(profile oauthProfile) audit.Principal {
	digest := sha256.Sum256([]byte(a.oauthProvider + "\x00" + profile.Subject))
	return audit.Principal{ID: "oauth:" + hex.EncodeToString(digest[:]), Source: "oauth", Username: profile.Username, DisplayName: profile.DisplayName, AuthMethod: "oauth"}
}
