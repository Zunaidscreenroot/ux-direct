# Model gateway smoke test (no paid API keys)

1. Keep all paid provider credentials empty.
2. Set `MODEL_GATEWAY_ACCESS_KEY` to a random local secret.
3. Set `MODEL_GATEWAY_ALLOW_UNAUTHENTICATED_LOCAL=true` only for local development, or use the access key.
4. Start the app with `npm run dev`.
5. Request `GET /api/model-gateway/models` with the access key and confirm mock is listed.
6. Send `POST /api/model-gateway/chat` with model `mock/ux-direct` and one user message; confirm a deterministic mock response and zero token usage.
7. Verify requests without the key are rejected.
8. Run unit tests and typecheck before connecting a real model provider.

No paid model request should be issued during these checks.
