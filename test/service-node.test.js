"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { URL } = require("node:url");

const service = require("../src");

function envelope(data, meta = {}) {
  return JSON.stringify({
    meta,
    data: Buffer.from(JSON.stringify(data), "utf8").toString("base64"),
  });
}

function decodeEnvelope(raw) {
  const env = JSON.parse(raw);
  return {
    meta: env.meta,
    data: Buffer.from(env.data || "", "base64").toString("utf8"),
  };
}

function rawEnvelope(data, meta = {}) {
  return JSON.stringify({
    meta,
    data: Buffer.from(data || "", "utf8").toString("base64"),
  });
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("service.new scans object methods and mounts them as routes", async () => {
  class GreeterService {
    greetUser(ctx, input) {
      ctx.setResponseMeta("ContentType", "application/json");
      return { message: `hello ${input.name}` };
    }

    meta() {
      return { name: "greeter" };
    }
  }

  const tunnel = service.new(new GreeterService());

  assert.equal(service.isTunnelNode(tunnel), true);
  assert.equal(await tunnel.meta(), '{"name":"greeter"}');
  assert.deepEqual(tunnel.listRoutes(), [
    { path: "/greet-user", name: "greetUser" },
  ]);

  const rsp = decodeEnvelope(
    await tunnel.invoke("/greet-user", envelope({ name: "Aura" }))
  );
  assert.equal(rsp.meta.ContentType, "application/json");
  assert.deepEqual(JSON.parse(rsp.data), { message: "hello Aura" });
});

test("service.new also accepts the original method name as route alias", async () => {
  const app = {
    getProfile(_ctx, input) {
      return { id: input.id };
    },
  };

  const tunnel = service.new(app);
  const rsp = decodeEnvelope(
    await tunnel.invoke("/getProfile", envelope({ id: 1001 }))
  );

  assert.deepEqual(JSON.parse(rsp.data), { id: 1001 });
});

test("service.new rejects objects without public handler methods", async () => {
  const app = {
    init() {},
    close() {},
    meta() {
      return {};
    },
  };

  assert.throws(
    () => service.new(app),
    /requires at least one public handler method/
  );
});

test("service.new rejects invalid targets", async () => {
  assert.throws(() => service.new(null), /requires a non-null service object/);
  assert.throws(() => service.new(() => {}), /requires a non-null service object/);
  assert.throws(() => service.new({}), /requires at least one public handler method/);
});

test("service.new returns Error meta when route is missing", async () => {
  const tunnel = service.new({ ok() { return "ok"; } });
  const rsp = decodeEnvelope(await tunnel.invoke("/missing", envelope({})));
  assert.match(rsp.meta.Error, /service route not found/);
});

test("service.new can pass payload as Buffer for byte-style handlers", async () => {
  const tunnel = service.new({
    echoBytes(_ctx, input) {
      assert.equal(Buffer.isBuffer(input), true);
      return input;
    },
  }, { payloadMode: "buffer" });

  const rsp = decodeEnvelope(
    await tunnel.invoke("/echo-bytes", envelope({ hello: "bytes" }))
  );

  assert.equal(rsp.data, '{"hello":"bytes"}');
});

test("service.web supports Express-style JSON POST apps", async () => {
  const app = {
    async handle(req, res, next) {
      try {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/api/users");
        assert.equal(req.headers["x-trace"], "abc");

        const body = JSON.parse(await readRequestBody(req));
        res.status(201).json({ name: body.name, created: true });
      } catch (err) {
        next(err);
      }
    },
  };

  const tunnel = service.web(app);
  const rsp = decodeEnvelope(await tunnel.invoke(
    "/fallback",
    rawEnvelope('{"name":"Aura"}', {
      Method: "POST",
      Path: "/api/users",
      Headers: {
        "Content-Type": "application/json",
        "X-Trace": "abc",
      },
    })
  ));

  assert.equal(service.isTunnelNode(tunnel), true);
  assert.equal(rsp.meta.Status, 201);
  assert.equal(rsp.meta.ContentType, "application/json");
  assert.equal(rsp.meta.Headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(rsp.data), { name: "Aura", created: true });
});

test("service.web maps GET path and query metadata", async () => {
  const tunnel = service.web((req, res) => {
    const url = new URL(req.url, "http://service.local");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      method: req.method,
      pathname: url.pathname,
      q: url.searchParams.get("q"),
      page: url.searchParams.get("page"),
    }));
  });

  const rsp = decodeEnvelope(await tunnel.invoke(
    "/search",
    rawEnvelope("", {
      Method: "GET",
      Query: { q: "node adapter", page: 2 },
    })
  ));

  assert.equal(rsp.meta.Status, 200);
  assert.deepEqual(JSON.parse(rsp.data), {
    method: "GET",
    pathname: "/search",
    q: "node adapter",
    page: "2",
  });
});

test("service.web returns 404 when Express-style app falls through", async () => {
  const tunnel = service.web({
    handle(_req, _res, next) {
      next();
    },
  });

  const rsp = decodeEnvelope(await tunnel.invoke("/missing", rawEnvelope("")));

  assert.equal(rsp.meta.Status, 404);
  assert.equal(rsp.data, "not found");
});

test("service.web propagates request headers and response status/content-type", async () => {
  const tunnel = service.web(async (req, res) => {
    const body = await readRequestBody(req);
    res.statusCode = 202;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Echo", req.headers["x-request-id"]);
    res.end(`accepted ${body}`);
  });

  const rsp = decodeEnvelope(await tunnel.invoke(
    "/jobs",
    rawEnvelope("job-42", {
      Header: {
        "X-Request-Id": "req-1",
      },
    })
  ));

  assert.equal(rsp.meta.Status, 202);
  assert.equal(rsp.meta.ContentType, "text/plain; charset=utf-8");
  assert.equal(rsp.meta.Headers["x-echo"], "req-1");
  assert.equal(rsp.data, "accepted job-42");
});

test("service.web supports Koa-style callback apps", async () => {
  const koaLike = {
    callback() {
      return (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      };
    },
  };

  const tunnel = service.web(koaLike);
  const rsp = decodeEnvelope(await tunnel.invoke("/koa", rawEnvelope("")));

  assert.equal(rsp.meta.Status, 200);
  assert.deepEqual(JSON.parse(rsp.data), { ok: true });
});

test("service.web supports http.Server request targets", async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 204;
    res.setHeader("x-method", req.method);
    res.end();
  });

  const tunnel = service.web(server);
  const rsp = decodeEnvelope(await tunnel.invoke(
    "/server",
    rawEnvelope("", { Method: "DELETE" })
  ));

  assert.equal(rsp.meta.Status, 204);
  assert.equal(rsp.meta.Headers["x-method"], "DELETE");
  assert.equal(rsp.data, "");
});

test("service.web preserves multipart/form-data as raw body with headers", async () => {
  const boundary = "----service-node-test-boundary";
  const multipartBody = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="field"',
    "",
    "value",
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="hello.txt"',
    "Content-Type: text/plain",
    "",
    "hello file",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const tunnel = service.web(async (req, res) => {
    const body = await readRequestBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      contentType: req.headers["content-type"],
      contentLength: req.headers["content-length"],
      body,
    }));
  });

  const rsp = decodeEnvelope(await tunnel.invoke(
    "/upload",
    rawEnvelope(multipartBody, {
      Method: "POST",
      Headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
    })
  ));

  assert.equal(rsp.meta.Status, 200);
  assert.deepEqual(JSON.parse(rsp.data), {
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: String(Buffer.byteLength(multipartBody)),
    body: multipartBody,
  });
});

test("service.web captures chunked responses and larger payloads", async () => {
  const requestBody = "req-".repeat(64 * 1024);
  const responseChunk = "rsp-".repeat(64 * 1024);

  const tunnel = service.web(async (req, res) => {
    const body = await readRequestBody(req);
    assert.equal(body, requestBody);
    res.setHeader("content-type", "text/plain");
    res.write(responseChunk.slice(0, responseChunk.length / 2));
    setImmediate(() => {
      res.end(responseChunk.slice(responseChunk.length / 2));
    });
  });

  const rsp = decodeEnvelope(await tunnel.invoke(
    "/large",
    rawEnvelope(requestBody, { Method: "POST" })
  ));

  assert.equal(rsp.meta.Status, 200);
  assert.equal(rsp.meta.ContentType, "text/plain");
  assert.equal(rsp.data, responseChunk);
});

test("service.web follows Go wire string semantics for request and response bodies", async () => {
  const body = "plain string, not JSON quoted";
  const tunnel = service.web(async (req, res) => {
    assert.equal(await readRequestBody(req), body);
    res.setHeader("content-type", "text/plain");
    res.end(`echo:${body}`);
  });

  const rsp = decodeEnvelope(await tunnel.invoke(
    "/echo-string",
    rawEnvelope(body, { Method: "POST" })
  ));

  assert.equal(rsp.meta.Status, 200);
  assert.equal(rsp.meta.ContentType, "text/plain");
  assert.equal(rsp.data, `echo:${body}`);
});

test("service.web leaves service.new object behavior unchanged", async () => {
  const tunnel = service.new({
    echo(_ctx, input) {
      return { input };
    },
  });

  assert.deepEqual(tunnel.listRoutes(), [{ path: "/echo", name: "echo" }]);

  const rsp = decodeEnvelope(await tunnel.invoke("/echo", envelope("same")));
  assert.deepEqual(JSON.parse(rsp.data), { input: "same" });
});
