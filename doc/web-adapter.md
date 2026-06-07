# service-node Web Adapter

`service.web(app, options)` wraps a Node web application as a Tunnel package.
It is intended for Express-style apps, Koa callbacks, plain `(req, res)`
handlers, and `http.Server` request targets.

## Envelope Contract

Requests use the same envelope shape as the Go dynamic web handlers:

```json
{
  "meta": {
    "Method": "POST",
    "Path": "/api/v1/code/history",
    "Headers": {
      "Content-Type": "application/json"
    }
  },
  "data": "eyJzY2VuZSI6InBheW1lbnQifQ=="
}
```

`data` is always the base64 form of the raw request bytes. The adapter does
not parse JSON, multipart bodies, or form bodies before handing the request to
the web app.

Responses are returned as the same envelope:

```json
{
  "meta": {
    "Status": 200,
    "ContentType": "application/json",
    "Headers": {
      "content-type": "application/json"
    }
  },
  "data": "eyJjb2RlIjowLCJtZXNzYWdlIjoic3VjY2VzcyIsImRhdGEiOltdfQ=="
}
```

`data` is the base64 form of the raw response bytes. String responses are
encoded as UTF-8 bytes, matching Go wire request/response string semantics
rather than JSON-quoting the string.

## Multipart/Form-Data

Multipart support is pass-through. The adapter preserves:

- the raw multipart body bytes;
- `Content-Type`, including the boundary;
- `Content-Length`, adding it from the decoded body when absent.

Business apps should keep using their normal middleware, such as `multer`,
`busboy`, or framework-native multipart parsing. The adapter does not inspect
or rewrite multipart parts.

## Streaming And Payload Size

The envelope protocol is request/response oriented, so `service.web` captures
the full request body and full response body in memory. Applications may call
`res.write()` multiple times, but the adapter buffers those chunks and returns
one envelope response after `res.end()`.

This means true response streaming is not exposed to the caller. Large payloads
are limited by available process memory and by the upstream Lambda invocation
payload limits. For workloads that need continuous streaming, use a native HTTP
Lambda/API Gateway path instead of the dynamic envelope adapter.

## Risk Module Example

`scp-api/risk` exposes its Express app through `tunnel/tunnel.js`:

```js
const service = require("@aura-studio/service-node");
const { app } = require("node-server/src/server.js");

const Tunnel = service.web(app);

module.exports = { Tunnel };
```

`dynamic-node-cli` packages that tunnel as `scp/risk/v1`. `lambda-node` in
`reqresp` mode receives a Lambda invoke payload such as:

```json
{
  "path": "/api/risk/v1/api/v1/code/history",
  "payload": "eyJzY2VuZSI6InBheW1lbnQifQ=="
}
```

The lambda runtime decodes the reqresp payload, maps the path to package
`risk`, version `v1`, and route `/api/v1/code/history`, then calls the dynamic
Tunnel with the envelope shown above. The risk Express app receives a normal
Node request and returns its normal Express response.
