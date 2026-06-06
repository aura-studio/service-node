# service-node Web Adapter TODO

Goal: let service-node wrap common Node.js web applications behind the existing
envelope protocol, so reqresp/sqs/event callers can reuse Express, Koa, and
plain Node HTTP handlers without writing one adapter per business module.

## Scope

- [x] ~~Define the adapter goal and compatibility boundary.~~
- [x] Keep the existing `service.new(object)` behavior unchanged.
- [x] Add a new entry point, such as `service.web(app, options)`.
- [x] Support Express-style apps with `app.handle(req, res, next)`.
- [x] Support Koa-style apps with `app.callback()`.
- [x] Support plain Node handlers shaped like `(req, res) => void`.
- [x] Support `http.Server` targets by emitting the `request` event.

## Envelope Mapping

- [x] Decode request envelope `{ meta, data }`.
- [x] Resolve HTTP method from `meta.Method`, defaulting to `POST`.
- [x] Resolve request URL from `meta.Path`, `meta.Query`, and route fallback.
- [x] Convert envelope headers into lower-case Node request headers.
- [x] Build a readable request stream from decoded `data`.
- [x] Capture response status, headers, writes, and final body.
- [x] Encode response as envelope `{ meta, data }`.
- [x] Map `Status` and `ContentType` response meta for lambda HTTP `/api`.

## MVP Tests

- [x] Add Express JSON POST test.
- [x] Add GET query test.
- [x] Add missing route / error response test.
- [x] Add header propagation test.
- [x] Add response status and content-type test.
- [x] Add backward-compatibility tests for existing object service mode.

## Later

- [ ] Evaluate multipart/form-data support.
- [ ] Evaluate streaming responses and large payload limits.
- [ ] Document risk module integration example.
- [ ] Compare behavior against Go wire request/response string semantics.
