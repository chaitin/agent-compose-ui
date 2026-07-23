package apitoken

import (
	"errors"
	"time"
)

type Role string

const (
	RoleAdmin         Role = "admin"
	RoleReadOnlyAdmin Role = "read-only-admin"
)

var (
	ErrInvalidToken = errors.New("invalid api token")
	ErrUnavailable  = errors.New("api token store unavailable")
)

func (r Role) Valid() bool {
	return r == RoleAdmin || r == RoleReadOnlyAdmin
}

type Metadata struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Role      Role       `json:"role"`
	CreatedAt time.Time  `json:"createdAt"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	RevokedAt *time.Time `json:"revokedAt,omitempty"`
}

type Created struct {
	Metadata
	Token string `json:"token"`
}

type Identity struct {
	ID   string
	Role Role
}
