# Security

Swarm Evolution is a local browser game. It has no account system, backend database, upload endpoint or external API. The Python server binds only to IPv4 loopback and serves a fixed asset list.

The server rejects ambiguous Host and framing headers, unexpected Origins, cross-site requests, linked assets and unsupported methods. It limits accepted connections, header size, header duration and asset size. Errors contain fixed messages, and request paths and query strings are not logged. Keep it on loopback; this development server is not a public hosting service.

The browser makes no external requests. The only optional saved record is a bounded best score and wave number in localStorage. Browser extensions, other software running as your account, and a compromised browser or operating system are outside this boundary. A seed in a URL may remain in browser history, so do not put private information in it.

## Reporting a vulnerability

Use [Security > Report a vulnerability](https://github.com/Jgolding1998/swarm-evolution/security/advisories/new) to send a private report. Do not submit vulnerability details through the public feedback form.

Include the affected version, platform, expected behavior and a synthetic reproduction. Leave out credentials, personal information and private files.
