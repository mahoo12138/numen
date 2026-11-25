# SMTP test certificates

`localhost-key.pem` and `localhost-cert.pem` are public, test-only key material for loopback TLS fixtures. They must never be used by a real SMTP deployment. The certificate covers `localhost`, `127.0.0.1`, and `::1`; tests explicitly trust this certificate through `caPem` and retain hostname verification.

The certificate is valid for ten years from its generation in October 2026. Regenerate it before expiry using a new self-signed certificate with the same loopback SANs, then rerun the TLS rejection and acceptance tests.
