package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"agent-compose-ui/internal/audit"
)

func (a *Manager) cookie(value string, expiresAt time.Time) *http.Cookie {
	maxAge := int(time.Until(expiresAt).Seconds())
	if value == "" {
		maxAge = -1
	}
	return &http.Cookie{Name: authCookieName, Value: value, Path: "/", Expires: expiresAt, MaxAge: maxAge, HttpOnly: true, SameSite: http.SameSiteLaxMode}
}

func (a *Manager) oauthStateCookie(state, next string, expiresAt time.Time) *http.Cookie {
	maxAge := int(time.Until(expiresAt).Seconds())
	if state == "" {
		maxAge = -1
	}
	return &http.Cookie{Name: oauthStateCookieName, Value: encodeOAuthStateCookie(state, next), Path: "/", Expires: expiresAt, MaxAge: maxAge, HttpOnly: true, SameSite: http.SameSiteLaxMode}
}

type sessionPayload struct {
	Version   int             `json:"v"`
	Principal audit.Principal `json:"principal"`
	ExpiresAt int64           `json:"expiresAt"`
}

func (a *Manager) signedValue(principal audit.Principal, expiresAt time.Time) string {
	payloadBytes, _ := json.Marshal(sessionPayload{Version: 2, Principal: principal, ExpiresAt: expiresAt.Unix()})
	payload := base64.RawURLEncoding.EncodeToString(payloadBytes)
	mac := hmac.New(sha256.New, a.secret)
	_, _ = mac.Write([]byte(payload))
	return payload + "." + hex.EncodeToString(mac.Sum(nil))
}

func (a *Manager) validateRequest(r *http.Request) (audit.Principal, time.Time, bool) {
	if !a.enabled {
		return audit.Principal{ID: "anonymous", Source: "anonymous", Username: "anonymous", DisplayName: "匿名", AuthMethod: "disabled"}, time.Time{}, true
	}
	if username, password, ok := r.BasicAuth(); ok && a.password != "" {
		if constantTimeEqual(username, a.username) && constantTimeEqual(password, a.password) {
			return a.localPrincipal(), time.Now().UTC().Add(a.ttl), true
		}
		return audit.Principal{}, time.Time{}, false
	}
	cookie, err := r.Cookie(authCookieName)
	if err != nil || cookie.Value == "" {
		return audit.Principal{}, time.Time{}, false
	}
	if principal, expiresAt, ok := a.validateV2Cookie(cookie.Value); ok {
		return principal, expiresAt, true
	}
	return a.validateLegacyCookie(cookie.Value)
}

func (a *Manager) validateV2Cookie(value string) (audit.Principal, time.Time, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		return audit.Principal{}, time.Time{}, false
	}
	mac := hmac.New(sha256.New, a.secret)
	_, _ = mac.Write([]byte(parts[0]))
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(parts[1]), []byte(expected)) != 1 {
		return audit.Principal{}, time.Time{}, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return audit.Principal{}, time.Time{}, false
	}
	var payload sessionPayload
	if json.Unmarshal(decoded, &payload) != nil || payload.Version != 2 || payload.Principal.ID == "" {
		return audit.Principal{}, time.Time{}, false
	}
	expiresAt := time.Unix(payload.ExpiresAt, 0).UTC()
	if !time.Now().UTC().Before(expiresAt) {
		return audit.Principal{}, time.Time{}, false
	}
	return payload.Principal, expiresAt, true
}

func (a *Manager) validateLegacyCookie(value string) (audit.Principal, time.Time, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return audit.Principal{}, time.Time{}, false
	}
	parts := strings.Split(string(decoded), "|")
	if len(parts) != 3 {
		return audit.Principal{}, time.Time{}, false
	}
	username, expiry, signature := parts[0], parts[1], parts[2]
	expiresUnix, err := strconv.ParseInt(expiry, 10, 64)
	if err != nil {
		return audit.Principal{}, time.Time{}, false
	}
	expiresAt := time.Unix(expiresUnix, 0).UTC()
	if !time.Now().UTC().Before(expiresAt) {
		return audit.Principal{}, time.Time{}, false
	}
	if username != a.username && (!a.oauthEnabled || username == "") {
		return audit.Principal{}, time.Time{}, false
	}
	expected := a.legacySignedValue(username, expiresAt)
	if subtle.ConstantTimeCompare([]byte(value), []byte(expected)) != 1 {
		return audit.Principal{}, time.Time{}, false
	}
	if _, err := hex.DecodeString(signature); err != nil {
		return audit.Principal{}, time.Time{}, false
	}
	principal := a.localPrincipal()
	if username != a.username {
		principal = audit.Principal{ID: "oauth:legacy:" + username, Source: "oauth", Username: username, DisplayName: username, AuthMethod: "oauth"}
	}
	return principal, expiresAt, true
}

func (a *Manager) legacySignedValue(username string, expiresAt time.Time) string {
	expiry := strconv.FormatInt(expiresAt.Unix(), 10)
	payload := username + "|" + expiry
	mac := hmac.New(sha256.New, a.secret)
	_, _ = mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload + "|" + hex.EncodeToString(mac.Sum(nil))))
}

func (a *Manager) localPrincipal() audit.Principal {
	return audit.Principal{ID: "local:" + a.username, Source: "local", Username: a.username, DisplayName: a.username, AuthMethod: "password"}
}

func generateOAuthState(length int) (string, error) {
	if length <= 0 {
		length = 16
	}
	buf := make([]byte, length)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func encodeOAuthStateCookie(state, next string) string {
	payload := state + "|" + sanitizeOAuthNext(next)
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

func decodeOAuthStateCookie(value string) (string, string, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return "", "", false
	}
	parts := strings.SplitN(string(decoded), "|", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	return parts[0], sanitizeOAuthNext(parts[1]), true
}

func constantTimeEqual(left, right string) bool {
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
