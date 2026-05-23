"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

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
