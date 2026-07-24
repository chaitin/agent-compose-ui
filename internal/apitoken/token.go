package apitoken

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"strings"
)

const (
	tokenPrefix       = "acp_"
	publicIDBytes     = 16
	secretBytes       = 32
	publicIDHexLength = publicIDBytes * 2
	secretHexLength   = secretBytes * 2
)

type parsedToken struct {
	id     string
	secret string
}

func generateToken() (parsedToken, string, error) {
	idBytes := make([]byte, publicIDBytes)
	secretBytesValue := make([]byte, secretBytes)
	if _, err := rand.Read(idBytes); err != nil {
		return parsedToken{}, "", err
	}
	if _, err := rand.Read(secretBytesValue); err != nil {
		return parsedToken{}, "", err
	}
	parsed := parsedToken{id: hex.EncodeToString(idBytes), secret: hex.EncodeToString(secretBytesValue)}
	return parsed, tokenPrefix + parsed.id + "_" + parsed.secret, nil
}

func parseToken(raw string) (parsedToken, error) {
	if len(raw) != len(tokenPrefix)+publicIDHexLength+1+secretHexLength || !strings.HasPrefix(raw, tokenPrefix) {
		return parsedToken{}, ErrInvalidToken
	}
	parts := strings.Split(raw[len(tokenPrefix):], "_")
	if len(parts) != 2 || len(parts[0]) != publicIDHexLength || len(parts[1]) != secretHexLength {
		return parsedToken{}, ErrInvalidToken
	}
	if _, err := hex.DecodeString(parts[0]); err != nil {
		return parsedToken{}, ErrInvalidToken
	}
	if _, err := hex.DecodeString(parts[1]); err != nil {
		return parsedToken{}, ErrInvalidToken
	}
	return parsedToken{id: parts[0], secret: parts[1]}, nil
}

func secretDigest(secret string) [sha256.Size]byte {
	return sha256.Sum256([]byte(secret))
}

func digestEqual(left, right []byte) bool {
	return subtle.ConstantTimeCompare(left, right) == 1
}
