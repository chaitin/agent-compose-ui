package audit

import "context"

type principalContextKey struct{}

func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, principalContextKey{}, principal)
}

func PrincipalFromContext(ctx context.Context) Principal {
	principal, _ := ctx.Value(principalContextKey{}).(Principal)
	if principal.ID == "" {
		return Principal{ID: "anonymous", Source: "anonymous", Username: "anonymous", DisplayName: "匿名", AuthMethod: "none"}
	}
	return principal
}
