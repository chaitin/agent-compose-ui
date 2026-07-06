package auth

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"golang.org/x/oauth2"
)

type authStatusResponse struct {
	Enabled      bool   `json:"enabled"`
	LoggedIn     bool   `json:"loggedIn"`
	OAuthEnabled bool   `json:"oauthEnabled"`
	Username     string `json:"username,omitempty"`
	ExpiresAt    string `json:"expiresAt,omitempty"`
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
	username, expiresAt, ok := a.validateRequest(r)
	resp := authStatusResponse{Enabled: a.enabled, LoggedIn: !a.enabled || ok, OAuthEnabled: a.oauthEnabled}
	if ok {
		resp.Username = username
		resp.ExpiresAt = expiresAt.UTC().Format(time.RFC3339)
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
		return echoJSON(c, http.StatusUnauthorized, map[string]string{"error": "invalid username or password"})
	}
	expiresAt := time.Now().UTC().Add(a.ttl)
	c.SetCookie(a.cookie(a.signedValue(a.username, expiresAt), expiresAt))
	return echoJSON(c, http.StatusOK, authStatusResponse{Enabled: true, LoggedIn: true, Username: a.username, ExpiresAt: expiresAt.Format(time.RFC3339)})
}

func (a *Manager) HandleLogout(c echo.Context) error {
	c.SetCookie(a.cookie("", time.Unix(0, 0).UTC()))
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
		return echoJSON(c, http.StatusNotFound, map[string]string{"error": "oauth is not configured"})
	}
	if authErr := r.URL.Query().Get("error"); authErr != "" {
		return echoJSON(c, http.StatusBadRequest, map[string]string{"error": "oauth authorization failed: " + authErr})
	}
	stateCookie, err := r.Cookie(oauthStateCookieName)
	if err != nil || stateCookie.Value == "" {
		return echoJSON(c, http.StatusBadRequest, map[string]string{"error": "oauth state cookie missing or expired"})
	}
	c.SetCookie(a.oauthStateCookie("", "", time.Unix(0, 0).UTC()))
	expectedState, next, ok := decodeOAuthStateCookie(stateCookie.Value)
	if !ok || expectedState == "" || expectedState != r.URL.Query().Get("state") {
		return echoJSON(c, http.StatusBadRequest, map[string]string{"error": "oauth state mismatch"})
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		return echoJSON(c, http.StatusBadRequest, map[string]string{"error": "authorization code is missing"})
	}
	token, err := a.oauth2Config.Exchange(r.Context(), code)
	if err != nil {
		slog.Error("oauth token exchange failed", "error", err, "token_url", a.oauth2Config.Endpoint.TokenURL, "redirect_url", a.oauth2Config.RedirectURL)
		return echoJSON(c, http.StatusBadGateway, map[string]string{"error": "failed to exchange authorization code"})
	}
	username, err := a.fetchOAuthUsername(r, token)
	if err != nil {
		return echoJSON(c, http.StatusBadGateway, map[string]string{"error": "failed to retrieve oauth user"})
	}
	if username == "" {
		username = a.oauthUser
	}
	expiresAt := time.Now().UTC().Add(a.ttl)
	c.SetCookie(a.cookie(a.signedValue(username, expiresAt), expiresAt))
	return c.Redirect(http.StatusFound, sanitizeOAuthNext(next))
}

func (a *Manager) fetchOAuthUsername(r *http.Request, token *oauth2.Token) (string, error) {
	if a.oauthUserInfo == "" {
		return a.oauthUser, nil
	}
	client := a.oauth2Config.Client(r.Context(), token)
	resp, err := client.Get(a.oauthUserInfo)
	if err != nil {
		return "", fmt.Errorf("call userinfo endpoint: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= http.StatusBadRequest {
		return "", fmt.Errorf("userinfo status %d", resp.StatusCode)
	}
	var info struct {
		ID       string `json:"id"`
		Sub      string `json:"sub"`
		Username string `json:"username"`
		Name     string `json:"name"`
		Email    string `json:"email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", fmt.Errorf("decode userinfo: %w", err)
	}
	return firstNonEmpty(info.Username, info.Email, info.Name, info.ID, info.Sub, a.oauthUser), nil
}
