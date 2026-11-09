# Security review summary, October 2026

Dispatch had a full security review in October 2026, covering v3.3.2. The detailed
report is private. The main fixes shipped in these releases:

| Release | What changed |
| --- | --- |
| v3.4.0 | Network gate and security headers on the daemon, private data directory |
| v3.4.1 | Secret names only in the UI, safer file routes, click to load images, Content-Security-Policy, updates follow release tags |
| v3.5.0 | A separate key for each thread |
| v3.8.0 | Thread reports treated as data, size and rate limits, smaller hardening fixes |
| v3.10.6 | More checks on risky actions, push subscription list and revoke, stability limits |

For how Dispatch handles security today, see [docs/security.md](../security.md).
