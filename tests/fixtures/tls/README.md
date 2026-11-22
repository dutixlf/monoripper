Test-only TLS material. `ca.crt` signs `server.crt` (SAN localhost, 127.0.0.1, ::1); `other.crt` is self-signed and untrusted.
The CA key was discarded after signing. Never use these files outside tests.
